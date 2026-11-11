# Excalibur

Persistent Excalidraw for humans and agents: live collaboration, organization
sharing, pinned comments, and an OAuth-protected MCP drawing toolkit. Postgres
stores scenes and images; PropelAuth provides identity and organizations.

![An AI agent creating a repository architecture diagram in Excalibur, with the resulting live canvas shown alongside the conversation](docs/images/architecture-demo.png)

[Architecture](docs/high-level-design.md) · [Helm chart](charts/excalibur/README.md)

**Credits:** Excalibur builds on [Excalidraw](https://github.com/excalidraw/excalidraw)
and uses [MCP Excalidraw Server](https://github.com/yctimlin/mcp_excalidraw) as its
upstream template and implementation reference for the agent drawing toolkit and
headless rendering. Thanks to their contributors! See [third-party notices](THIRD_PARTY_NOTICES.md).

Requires Node.js **22.13+**, pnpm **9.1.0**, and Postgres **16+** or Docker Compose.

## Run with Docker Compose

Copy env templates only on first setup; preserve existing credentials.

```sh
cp .env.compose.example .env.compose
pnpm compose up --build
```

Open **http://localhost:53080**. Postgres is available at **localhost:55432**.
Override host ports with `COMPOSE_APP_PORT` and `PGPORT` in `.env.compose`.
Database contents persist in the `postgres-data` volume.

`pnpm compose` explicitly loads `.env.compose`; plain `docker compose` loads
`.env` instead. Both local env files are git-ignored and excluded from image builds.

### Localhost and an ngrok tunnel

Run `ngrok http 53080`, then set these in `.env.compose` using its HTTPS URL:

```dotenv
PUBLIC_URL=https://your-url.ngrok-free.app
ALLOWED_ORIGINS=http://localhost:53080,https://your-url.ngrok-free.app
```

Rebuild/recreate the app with `pnpm compose up -d --build app`. Both browser
addresses work; Docker can stay bound to localhost. `ALLOWED_ORIGINS` is an
explicit, comma-separated list of HTTP(S) origins, not wildcards or URL paths.
It does not enable CORS or change the listening address. `PUBLIC_URL` remains
canonical for generated links and MCP OAuth discovery/token audiences.

**The allowlist is not authentication.** Configure PropelAuth or protect the
tunnel with ngrok access controls before exposing development mode. Without
authentication, everyone admitted through the tunnel shares full development access.

## Development

For hot reload, run Postgres in Compose and the app locally:

```sh
pnpm install
cp .env.example .env
cp .env.compose.example .env.compose # Skip if already configured.
pnpm compose up -d postgres
pnpm dev
```

Open **http://localhost:5173**; Vite proxies the backend on port 3000.
`pnpm dev` loads `.env`. Keep Postgres credentials consistent between the two env
files. Other commands do not automatically load `.env`.

The example configurations disable authentication for local use. **Never expose
development mode publicly.** `pnpm dev --allow-local` enables unauthenticated
access from other devices on a trusted LAN.

## Authentication

Set these in `.env` for development, `.env.compose` for Compose, or runtime secrets
for deployment:

```dotenv
AUTH_MODE=propelauth
PUBLIC_URL=https://draw.example.com
PROPELAUTH_AUTH_URL=https://your-project.propelauthtest.com
PROPELAUTH_API_KEY=your-server-side-api-key
```

Register `PUBLIC_URL` and any additional browser origins from `ALLOWED_ORIGINS`
in PropelAuth and add users to organizations. Origins are exact: `localhost` and
`127.0.0.1` are not interchangeable. Use `PUBLIC_URL` for MCP OAuth clients.
Outside local development, authentication defaults to PropelAuth and missing
credentials fail startup.

Canvases start private. Creators can share them with their organization, rename
them, or permanently delete them. Links alone never grant access.

## MCP

Connect your agent client to **`${PUBLIC_URL}/mcp`** using Streamable HTTP and OAuth.
For authenticated MCP:

1. Create a PropelAuth **MCP → Request Validation** credential pair:

   ```dotenv
   PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID=...
   PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET=...
   ```

2. Create the **organization scope** `canvases:access` and grant it to appropriate roles.
3. Configure client registration/callbacks in PropelAuth, then authorize your MCP client.

Without the Request Validation pair, authenticated MCP stays disabled; browser
login still works. These credentials are separate from the backend API key.

Tools discover their schemas automatically. Reuse an explicit canvas ID or browser
URL across calls. Agents can edit drawings, manage comments, and export scenes or
headless PNG/SVG images. MCP organization selection is independent of the browser's.

## Deployment and operations

- Use the [Helm chart](charts/excalibur/README.md) for Kubernetes, optional bundled
  Postgres, Ingress, and AWS Secrets Manager integration through ESO.
- Run **one app replica**: rooms, events, and live tickets are process-local.
- Configure Postgres with `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD`.
  Migrations run at startup. Changing env credentials does not update existing database roles.
- Use HTTPS/WSS and preserve the public Host header, including on health probes.
  Proxies must support WebSockets/MCP streaming and 24 MiB requests. Redact live-route
  query strings and authorization headers from logs.
- Sharing or membership changes do not forcibly disconnect existing live subscriptions.
- If disconnected with unconfirmed edits, export unsaved work before reloading;
  offline edits are not replayed automatically.

Back up the entire database, including images and comments:

```sh
pnpm --silent compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -Fc "$POSTGRES_DB"' > excalibur.dump
```

## Checks

Create the test database once:

```sh
pnpm compose exec postgres sh -c 'createdb -U "$POSTGRES_USER" excalibur_test'
pnpm typecheck
pnpm test
pnpm build
```

Tests use `excalibur_test` with local Compose defaults and require schema-creation
permissions. Export `PG*` variables or `TEST_DATABASE_URL` for custom connections;
tests do not load `.env` automatically.

## Releases

CI checks every PR and push to `main`. To release, push a new `vMAJOR.MINOR.PATCH` tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

After CI passes, the workflow publishes the amd64/arm64 image and matching Helm
chart to GHCR, then creates a GitHub release with installation instructions.
It uses `GITHUB_TOKEN`; no registry secret is needed. Make both GHCR packages
public after the first release.
