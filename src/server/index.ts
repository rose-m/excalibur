import { serve } from "@hono/node-server";
import { config } from "./config.js";
import { CanvasService } from "./canvas/service.js";
import { createApp } from "./http/app.js";
import { SqliteCanvasRepository } from "./persistence/sqlite.js";
import { createLiveServer } from "./live/server.js";
import { localAddresses } from "./local-network.js";
import { propelAuthentication } from "./auth/propelauth.js";

const repository = new SqliteCanvasRepository(config.databasePath);
const service = new CanvasService(repository);
const authentication = config.authMode === "propelauth" ? propelAuthentication(config.authUrl!, config.apiKey!) : undefined;
const app = createApp(service, config.webDirectory, config.port, config.publicUrl, { allowLocal: config.allowLocal }, authentication);
const liveServer = createLiveServer();
const server = serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
  serverOptions: { requestTimeout: 30_000 },
  websocket: liveServer.adapter,
}, () => {
  console.log(`Excalibur listening on http://${config.host}:${config.port}`);
  if (!authentication) console.warn("Authentication is disabled. Local development only; do not expose this service publicly.");
  if (config.allowLocal) {
    console.warn("LAN access is enabled. Anyone who can reach this server can read and edit canvases, including through MCP. Use a trusted network only.");
    for (const address of localAddresses()) console.log(`LAN: http://${address}:${config.port}`);
  }
});

function shutdown() {
  const timeout = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  timeout.unref();
  for (const socket of liveServer.sockets.clients) socket.close(1001, "Server shutting down");
  const socketsClosed = new Promise<void>((resolve) => liveServer.sockets.close(() => resolve()));
  const httpClosed = new Promise<Error | undefined>((resolve) => server.close((error) => resolve(error)));
  void Promise.all([httpClosed, socketsClosed, app.closeMcp()]).then(([error]) => {
    clearTimeout(timeout);
    repository.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }).catch((error: unknown) => {
    console.error("Shutdown failed", error instanceof Error ? error.message : "Unknown error");
    process.exitCode = 1;
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
