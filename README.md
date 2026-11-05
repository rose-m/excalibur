# Excalibur

A persistent Excalidraw service for humans and agents. The local-only React editor
supports live canvas collaboration with SQLite persistence and a canvas-scoped
HTTP MCP toolkit. Authentication is deferred; this service is local-only.

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

**There is no authentication. Do not expose either server publicly.** Every local
session uses the same fixed development user and organization. The backend binds
to loopback by default and rejects non-local hosts and unrelated browser origins.
These safeguards are not a substitute for authentication.

Configuration is read from environment variables; see `.env.example`. Local
`.env` files are not automatically loaded. `HOST`, `PORT`, `PUBLIC_URL`, and `DATABASE_PATH` are
supported. Vite's API proxy assumes the default backend port 3000; update
`vite.config.ts` if changing it.

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm start
```

After building, **http://127.0.0.1:3000** serves both the UI and API. Editor fonts
are copied from the pinned Excalidraw package and served locally. The editor is
lazy-loaded; its upstream bundle is large and currently triggers Vite's chunk-size
warning.

## MCP

Register **http://127.0.0.1:3000/mcp** as a Streamable HTTP MCP server in your
agent client. Agents can create and edit persistent canvases, arrange drawings,
and export scenes or headless PNG/SVG images. Open a canvas's returned browser
URL to watch edits live.

Every drawing operation requires an explicit canvas ID or application canvas
URL; reuse it across reconnects. Edits are atomic and support revision checks.
The client discovers the available tools and their parameters automatically.
Selections are available per connected editor tab; they are temporary and cleared
on disconnect, without changing the saved canvas or its revision.

`PUBLIC_URL` controls returned canvas URLs: port 5173 in development, port 3000
by default in production. Standard development and build commands prepare the
headless renderer automatically.

**No authentication is enabled. Keep the endpoint local-only.**

## Persistence and save behavior

- Numbered SQL migrations in `migrations/` run transactionally on server startup.
- Canvas service operations carry a server-created user/organization context.
  Owner and organization access checks are already in place; later authentication
  must validate membership before supplying that context.
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

HTTP endpoints: `GET/POST /api/canvases`, `GET/PUT /api/canvases/:id`, and
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
  - `auth/`: operation context and fixed development identity.
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
The image contains the server, built web assets, fonts and migrations, and runs as
a non-root user. SQLite lives on the named volume mounted at `/app/data`.

For a consistent backup, stop the application, copy the entire data directory or
volume, then restart it. Restore the whole dataset while the application is
stopped, preserving permissions for the container's `node` user. Do not copy only
the SQLite main file from a running service: its WAL may contain committed data.
