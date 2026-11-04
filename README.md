# Excalibur

An authenticated, live Excalidraw service for humans and agents, with a web UI, HTTP API, and remote MCP server.

See the [high-level design](docs/high-level-design.md) for scope, architecture, permissions, and deployment direction.

## Development

Requires Node.js 22+ and pnpm 9.1.0 (`corepack enable` to use the pinned version).

```sh
pnpm install
pnpm dev
```

The bootstrap server listens on port 3000. `GET /health/live` returns a liveness
response; all other routes return 404. The UI, authentication, persistence, MCP,
and collaboration are not implemented yet. There is no readiness endpoint until
application dependencies are wired up.

Configuration is read from environment variables; see `.env.example`. Local
`.env` files are not automatically loaded.

```sh
pnpm typecheck
pnpm build
pnpm start
```

## Structure

- `src/web/`: browser UI and Excalidraw integration.
- `src/server/`: application startup and configuration.
  - `auth/`: identity validation and canvas access checks.
  - `canvas/`: shared canvas service and reconciliation.
  - `http/`, `mcp/`, `live/`: transport adapters and live rooms.
  - `persistence/`: storage interfaces and SQLite adapter.
  - `render/`: headless rendering.
- `src/shared/`: transport schemas and shared types.
- `migrations/`: versioned database migrations.
- `tests/`: integration and end-to-end tests; unit tests live beside their code.

The empty directories are placeholders, not implemented modules. Framework and
SDK choices remain open. This is a single package, not a pnpm workspace.

## Container

```sh
docker compose up --build
```

Compose reserves a persistent volume at `/app/data` for future storage. The
bootstrap does not write data yet. The image currently contains only the server;
web assets and runtime dependencies must be included as those are introduced.
