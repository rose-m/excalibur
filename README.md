# Excalibur

A persistent Excalidraw service for humans and agents. The first slice is a
local-only React editor with SQLite persistence. Authentication, live collaboration,
and remote MCP are planned, not implemented.

See the [high-level design](docs/high-level-design.md) for scope, architecture, permissions, and deployment direction.

## Development

Requires Node.js **22.13+** and pnpm 9.1.0 (`corepack enable` to use the pinned version).
SQLite uses Node's built-in `node:sqlite` module, which may emit an experimental
warning on Node 22; no native database dependency or separate server is needed.

```sh
pnpm install
pnpm dev
```

Open **http://127.0.0.1:5173**. Vite proxies API calls to the server on port 3000.
Create a canvas, draw, wait for “Saved”, and reopen its `/canvases/:id` URL.
Scenes and image bytes survive server restarts in `data/excalibur.sqlite`.

**There is no authentication. Do not expose either server publicly.** Every local
session uses the same fixed development user and organization. The backend binds
to loopback by default and rejects non-local hosts and unrelated browser origins.
These safeguards are not a substitute for authentication.

Configuration is read from environment variables; see `.env.example`. Local
`.env` files are not automatically loaded. `HOST`, `PORT`, and `DATABASE_PATH` are
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
  supported. Limits: 5 MiB per image, 15 MiB total images, 24 MiB request payload,
  and 20,000 elements.
- Autosave is debounced and serialized. The scene, assets and increasing revision
  commit atomically before success is returned. Errors remain visible and unsaved
  edits trigger a navigation warning.
- This slice submits **full snapshots with revision preconditions**, not a
  collaboration protocol. Stale saves return `409` instead of overwriting another
  tab. Export any unsaved work before reloading after a conflict. Incremental
  mutations and reconciliation are the next collaboration prototype.

HTTP endpoints: `GET/POST /api/canvases`, `GET/PUT /api/canvases/:id`, and
`GET /health/live` / `GET /health/ready`. Create accepts `{ "title": "My canvas" }`;
save accepts `{ "expectedRevision": 0, "scene": { ... } }`. Identity and ownership
fields cannot be supplied in either request.

## Structure

- `src/web/`: browser UI and Excalidraw integration.
- `src/server/`: application startup and configuration.
  - `auth/`: operation context and fixed development identity.
  - `canvas/`: shared canvas service and access checks.
  - `http/`: API and built-web-asset serving.
  - `persistence/`: storage interfaces and SQLite adapter.
  - `render/`: headless rendering.
- `src/shared/`: transport schemas and shared types.
- `migrations/`: versioned database migrations.
- `tests/`: service, persistence, HTTP, and scene helper tests.

`mcp/`, `live/`, and `render/` remain placeholders. React 18 is used to match the
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
