# Excalibur

A persistent Excalidraw service for humans and agents. The React editor supports
live canvas collaboration with SQLite persistence. PropelAuth protects the web UI,
HTTP API and WebSockets. The canvas-scoped HTTP MCP toolkit supports PropelAuth
OAuth authentication for agents acting on behalf of users.

See the [high-level design](docs/high-level-design.md) for scope, architecture, permissions, and deployment direction.

## Development

Requires Node.js **22.13+** and pnpm 9.1.0 (`corepack enable` to use the pinned version).
SQLite uses Node's built-in `node:sqlite` module, which may emit an experimental
warning on Node 22; no native database dependency or separate server is needed.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. Vite proxies HTTP and WebSocket calls to port 3000.
Create a canvas and open its `/canvases/:id` URL in two tabs to edit together.
Wait for “Live · Saved” before closing.
Scenes and image bytes survive server restarts in `data/excalibur.sqlite`.

For iPad or other devices on the same trusted network:

```sh
pnpm dev --allow-local
```

Open one of the printed LAN URLs on the device. This binds both servers to
`0.0.0.0` and permits this machine's private IPv4 addresses and matching browser
origins. The default remains loopback-only. **LAN mode exposes the editor, API,
and MCP without authentication—do not use it on an untrusted network or forward
these ports publicly.** Some browser features, such as clipboard access, still
require HTTPS outside localhost.

**The default `pnpm dev` mode has no authentication. Do not expose either server publicly.** Every local
session uses the same fixed development user and organization. The backend binds
to loopback by default and rejects non-local hosts and unrelated browser origins.
These safeguards are not a substitute for authentication.

Configuration is read from environment variables; see `.env.example`. `pnpm dev`
loads `.env` when present; existing shell variables take precedence. Other commands
do not automatically load `.env`. `HOST`, `PORT`, `PUBLIC_URL`, and `DATABASE_PATH` are
supported. Vite's proxy follows `PORT` (3000 by default).

```sh
pnpm typecheck
pnpm test
pnpm build
AUTH_MODE=development pnpm start
```

After building, **http://127.0.0.1:3000** serves both the UI and API. Editor fonts
are copied from the pinned Excalidraw package and served locally. The editor is
lazy-loaded; its upstream bundle is large and currently triggers Vite's chunk-size
warning.

## PropelAuth login and live authentication

Use the same application image for local or authenticated deployment. Outside
the development commands, `AUTH_MODE` defaults to `propelauth`; missing credentials
fail startup. `AUTH_MODE=development` is an explicit local-only opt-out. Supplying
PropelAuth credentials in development mode is rejected to prevent accidental bypass.

1. Create or choose a PropelAuth project/environment. Configure its Application
   URL and allowed frontend origins to match `PUBLIC_URL` exactly, including port.
   For local authenticated development, use `http://127.0.0.1:5173` consistently
   (do not alternate with `localhost`).
2. Enable the desired login methods and invite users into organizations. The UI
   uses PropelAuth-hosted login, returns to the original canvas link, and offers
    an Account menu with organization switching and sign-out. Users with no org see
    an invitation message. Accounts with multiple orgs choose a workspace.
3. Provide runtime environment variables, then run `pnpm dev` or the built server:

   ```sh
   export AUTH_MODE=propelauth
   export PROPELAUTH_AUTH_URL=https://your-project.propelauthtest.com
   export PROPELAUTH_API_KEY=your-server-side-api-key
   export PUBLIC_URL=http://127.0.0.1:5173 # production: https://draw.example.com
   pnpm dev
   ```

The API key is server-only. The browser receives only the auth mode and public
Auth URL from `/api/auth/config`, so images do not need rebuilding for each
environment. `pnpm dev` loads these variables from `.env` when present. For other
commands, export/inject them or use Node's `--env-file=.env` option.

API requests send `Authorization: Bearer <access-token>` and `x-organization-id`
for the selected organization. The server validates that selection against current
membership; only sole memberships can omit it. Users with no memberships cannot
access canvases. Deep links use the same organization and canvas access checks.
Identity always comes from the validated token. Org membership and enabled/unlocked account status are
checked against PropelAuth on every HTTP request and ticket issuance; auth
service failures deny access. This deliberately trades an extra network call for
fresh authorization. Private canvases remain creator-only within their org.

For live editing, the browser first calls
`POST /api/canvases/:id/live-ticket` with its bearer token and `Origin`. It then
connects to `/api/canvases/:id/live?ticket=...`. Tickets are random, single-use,
valid for 30 seconds, and bound to the user/org, canvas and exact browser origin.
Every reconnect requests a new ticket. Ticket state is process-local and bounded;
a restart invalidates pending tickets. No long-lived bearer token enters a URL.
**Redact query strings on live routes in reverse-proxy/access logs**, since even
short-lived tickets are credentials. The application does not log ticket URLs.

Membership is checked at ticket issuance; an already-issued ticket has at most
a 30-second authorization window. Established live connections retain their
authorization until disconnect, including after token expiry or remote membership
revocation. Signing out in the app unmounts the editor and closes its socket.
Immediate cross-device revocation is not implemented. Authorization failures
stop live editing; export unsaved work before reloading/signing in again.

In production, use HTTPS/WSS behind a trusted reverse proxy. Preserve the public
`Host` header and support WebSocket upgrades; forwarded headers are not trusted.
Only the configured `PUBLIC_URL` origin/host is accepted for web API calls and upgrades.
Cross-site top-level HTML navigation is allowed so hosted login can return to the app.
Health probes must use that public Host header too. `--allow-local` is for
unauthenticated development only. Do not publish Vite in production.

Existing local canvases retain `development-user` / `development-organization`
ownership and are **not** automatically claimed by the first logged-in user.
Back up the database before any deliberate ownership migration.

## MCP

Register **`${PUBLIC_URL}/mcp`** as a Streamable HTTP MCP server in your
agent client (`http://127.0.0.1:5173/mcp` for authenticated development).
Agents can create and edit persistent canvases, arrange drawings,
and export scenes or headless PNG/SVG images. Open a canvas's returned browser
URL to watch edits live.

Every drawing operation requires an explicit canvas ID or application canvas
URL; reuse it across reconnects. Edits are atomic and support revision checks.
The client discovers the available tools and their parameters automatically.
Selections are available per connected editor tab; they are temporary and cleared
on disconnect, without changing the saved canvas or its revision.

`PUBLIC_URL` controls returned canvas URLs: port 5173 in development (using a LAN
address with `--allow-local`), port 3000 by default in production. Standard
development and build commands prepare the headless renderer automatically.

### MCP OAuth setup

1. Enable MCP for the same PropelAuth project/environment used for browser login.
2. In **MCP → Request Validation**, create a client ID/secret pair and put both
   in `.env` (or injected runtime secrets):

   ```dotenv
   PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID=...
   PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET=...
   ```

   These are **not** the backend API key or the MCP client's own OAuth credentials.
   Partial pairs fail startup. If neither is supplied, the browser still works
   but MCP and its discovery routes return `503`; they never fall back to no auth.
3. Configure the allowed MCP client's callback URI in PropelAuth. Enable the
   client-registration method it supports (for example DCR), or use a pre-registered
   OAuth client. PropelAuth handles registration, login/consent, PKCE and tokens;
   Excalibur does not host its own authorization server or rewrite its issuer.
4. In **MCP → Org Scopes**, create `canvases:access` and make it available to the
   organization roles that should use Excalibur. This must be an **organization**
   scope, not a user scope, so hosted consent selects an organization.
5. Restart `pnpm dev`, connect the client to `${PUBLIC_URL}/mcp`, and authorize it
   through PropelAuth. Select the organization and grant `canvases:access`.
   Existing clients must reauthorize; old unscoped tokens no longer work.

The canonical resource/audience is exactly `${PUBLIC_URL}/mcp`, not the backend
listener address or a canvas URL. In development, Vite proxies MCP and discovery
on port 5173, preserving the public Host. Do not connect an authenticated client
directly to port 3000 when `PUBLIC_URL` uses 5173. In production, use the public
HTTPS origin behind the same trusted proxy as the web UI.

Public, credential-free resource discovery is available at
`/.well-known/oauth-protected-resource/mcp` (and the root alias
`/.well-known/oauth-protected-resource`). It advertises the PropelAuth
`{AUTH_URL}/oauth/2.1` authorization server, the `canvases:access` scope, and header-only
bearer tokens. Unauthenticated MCP requests return `401` with a
`WWW-Authenticate` challenge pointing to that document. Authorization-server
metadata is served by PropelAuth at
`{AUTH_URL}/.well-known/oauth-authorization-server/oauth/2.1`.

Every MCP exchange introspects its OAuth access token, checks active state,
expiry, exact resource audience and trusted PropelAuth issuer, then fetches the
current user's enabled/unlocked status and org memberships. Tokens are not cached.
Provider outages or invalid introspection credentials return `503` without
exposing upstream details. Browser JWTs, cookies, query tokens, API keys and
service identities are not alternative MCP authentication paths.

The token's `sub` is the creator of canvases made by an agent. Each authorization
is bound to the token's `org_id`, selected during hosted consent. Users may belong
to multiple organizations, but must still belong to the selected organization.
Missing org claims are rejected even for single-org users; missing scopes return
`403 insufficient_scope` with an OAuth challenge. Changing MCP organizations
requires reauthorization. Browser selections, headers and tool arguments cannot
override the MCP token's organization. Private
canvases remain creator-only; all canvas reads, edits, comments, assets and renders
use the existing shared access checks.

Browser login automatically opens a sole organization, or shows a picker for
multiple memberships. The selection is remembered per user in this tab's
`sessionStorage` and validated against current membership on page load. Browser
API requests send `x-organization-id`; the server checks current membership on
every request. Switching organizations navigates to the canvas list in a new page,
closing the old live connection and preserving the editor's unsaved-change prompt.
This does not switch existing MCP authorizations. When opening an MCP-created
canvas URL, select the same organization in the browser.

Authenticated MCP accepts any `Origin` (or no `Origin`) and serves protocol and
discovery responses with `Access-Control-Allow-Origin: *`. Bearer tokens are still
required; browser cookies are not used and credentialed CORS is not enabled.
Public Host validation remains in place. This does not relax the same-origin policy
on the web API or WebSockets, or the safeguards for unauthenticated local development.
Include `WWW-Authenticate` in any proxy response-header
allowlist and never log Authorization headers or introspection request bodies.

For a quick check, public discovery must return `200` and an unauthenticated
`POST /mcp` must return `401`. Then verify real login/consent in your target MCP
client, create a canvas, and open its returned URL as the same user to watch live
edits. The test suite covers the SDK discovery/DCR/PKCE/code exchange against a
simulated issuer and authenticated MCP-to-browser editing; real hosted consent
requires your dashboard setup and is a separate acceptance check.

`AUTH_MODE=development` retains the unauthenticated local-only MCP endpoint at
`http://127.0.0.1:3000/mcp` (also proxied on 5173). Do not expose that mode publicly.

## Rename and delete canvases

The creator can open **Canvas actions** (the **…** button in the navigation bar) to rename
or permanently delete a canvas. Other organization members can edit a shared
drawing but cannot rename or delete the canvas.

Renaming updates open editors without reloading the scene or changing its assets,
comments or visibility. HTTP clients use `PATCH /api/canvases/:id` with
`{ "title": "New name", "expectedTitle": "Previous name" }`; agents use
`rename_canvas` with the same fields plus `canvasId`. Names are trimmed and limited
to 200 characters. Same-name retries do not advance the revision; stale previous
names return `409`.

Deletion requires typing the exact current canvas name in the confirmation dialog.
The dialog reviews a fresh canvas snapshot before enabling deletion. HTTP clients
use `DELETE /api/canvases/:id` with `{ "confirmTitle": "Current name",
"expectedRevision": 12 }`; agents use `delete_canvas` with the same fields plus
`canvasId`, only after explicit user confirmation. A changed name or canvas revision
returns `409` and requires another review and confirmation, not automatic retry.

Deletion atomically removes the canvas, all image assets and comments. There is no
trash or undo. All its live connections close, pending tickets cannot reopen it,
and later requests return `404`. Other open editors stop sending/reconnecting and
retain their local scene for export. The deleting tab returns to the canvas list
after success; its typed confirmation explicitly includes discarding unsaved work.

## Organization sharing

New canvases are private. Open **Canvas actions → Share canvas** to copy the
canvas link or change access. Only the creator can change sharing:

- **Private**: only the creator can view and edit, while still a current org member.
- **Organization**: all current members of that organization can view, edit, and
  comment. Other organizations remain excluded, even if a user belongs to both.

Links never grant access by themselves. Recipients must sign in and select the
canvas's organization. The canvas list shows its actual visibility.

**Save now** is also in Canvas actions. It is available to all live editors and
disabled while disconnected. Save status remains visible in the navigation bar;
automatic saving is unchanged.

Agents use `set_canvas_visibility` with an explicit canvas ID or application URL,
`visibility` (`private` or `organization`), and `expectedVisibility` read from
`get_canvas`. The same creator-only checks apply. HTTP clients use
`PATCH /api/canvases/:id/visibility` with `{ "visibility": "organization",
"expectedVisibility": "private" }`. Stale visibility changes return `409`; repeating
the already-current visibility succeeds without another update.

Sharing changes persist atomically, advance the canvas revision, and update open
editors without changing scene elements, image assets or comments. Making a canvas
private denies other members' new reads, edits, comments, renders, tickets and
reconnects. **Existing live subscriptions are not forcibly disconnected** and may
continue receiving updates until they disconnect. Do not treat a visibility change
as immediate revocation of data already delivered to a browser.

## Pinned comments

Use **Comment** beside the drawing toolbar (or press **C** with the editor focused),
then click an element or blank canvas to leave a note. Element pins follow movement,
resizing, and rotation. Open a pin
and choose **Resolve** to delete the note. Comments persist and sync across tabs,
but stay separate from drawing revisions and Excalidraw/image exports. Deleting
a drawing element keeps its notes at the element's last retained position.
Use **Edit** on an open note to change its text; edits sync across tabs.
Agents can also retrieve, add, and resolve notes through MCP.

## Persistence and save behavior

- Numbered SQL migrations in `migrations/` run transactionally on server startup.
- Canvas service operations carry a server-created user/organization context.
  Authenticated mode validates current membership before supplying that context.
- Scenes preserve native element fields, bindings, ordering and deletion
  tombstones. Only the canvas background is a shared editor setting for now;
  viewport, selection, and other local state are not persisted.
- Images are stored as separate SQLite blobs and returned only through the owning
  canvas read. PNG, JPEG, GIF and WebP are supported; SVG imports are not yet
  supported. Limits: 5 MiB per image, 15 MiB total images, 24 MiB request/message
  and scene size, and 20,000 elements.
- Incremental element/file updates are debounced and serialized. The scene, assets and increasing revision
  commit atomically before success is returned. Errors remain visible and unsaved
  edits trigger a navigation warning.
- The server reconciles element versions and nonces using the pinned Excalidraw
  semantics, preserves tombstones, and repairs fractional ordering. This resolves
  whole-element conflicts, not every property or concurrent text edit.
- Clean reconnects reload an authoritative snapshot. If a connection is lost
  with local or unacknowledged edits, editing stops: export unsaved work, then
  explicitly reload. Offline edits are never silently replayed.

HTTP endpoints: `GET/POST /api/canvases`, `GET/PUT/PATCH/DELETE /api/canvases/:id`, and
`POST /api/canvases/:id/mutations`, plus `GET /health/live` / `GET /health/ready`.
Create accepts `{ "title": "My canvas" }`. Mutations accept changed `elements`,
optional `files` / `sharedSettings`, and an optional `expectedRevision` for
read–modify–write clients. Revision conflicts return `409`.

The compatibility PUT accepts `{ "expectedRevision": 0, "scene": { ... } }` but
now reconciles elements rather than replacing the entire scene. Omitting an
element does not delete it; send a versioned `isDeleted` tombstone.

WebSockets join `/api/canvases/:id/live`. Identity and ownership fields are never
accepted from client payloads.

## Structure

- `src/web/`: browser UI and Excalidraw integration.
- `src/server/`: application startup and configuration.
  - `auth/`: PropelAuth adapter, single-use live tickets and development identity.
  - `canvas/`: shared canvas service and access checks.
  - `http/`: Hono API routes, middleware, and built-web-asset serving.
   - `live/`: canvas-scoped WebSocket subscriptions and heartbeat/backpressure handling.
   - `mcp/`: explicit-canvas HTTP MCP tools and protocol routing.
  - `persistence/`: storage interfaces and SQLite adapter.
  - `render/`: headless rendering.
- `src/shared/`: transport schemas and shared types.
- `migrations/`: versioned database migrations.
- `tests/`: service, persistence, HTTP, WebSocket, and client scene helper tests.

React 18 is used to match the
pinned Excalidraw component's transitive peer dependencies. This is a single
package, not a pnpm workspace.

## Container

```sh
docker compose up --build
```

Open http://127.0.0.1:3000. Compose publishes the container only on host loopback.
Compose explicitly defaults to local development auth. To enable PropelAuth, set
`AUTH_MODE=propelauth`, `PROPELAUTH_AUTH_URL`, `PROPELAUTH_API_KEY` and `PUBLIC_URL`
in the Compose environment (or a private Compose `.env`). Route your HTTPS proxy
to the loopback-published port and preserve the public Host header.
The image contains the server, built web assets, fonts and migrations, and runs as
a non-root user. SQLite lives on the named volume mounted at `/app/data`.

For a consistent backup, stop the application, copy the entire data directory or
volume, then restart it. Restore the whole dataset while the application is
stopped, preserving permissions for the container's `node` user. Do not copy only
the SQLite main file from a running service: its WAL may contain committed data.
