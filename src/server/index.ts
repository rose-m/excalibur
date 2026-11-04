import { createServer } from "node:http";
import { config } from "./config.js";
import { CanvasService } from "./canvas/service.js";
import { createHandler } from "./http/app.js";
import { SqliteCanvasRepository } from "./persistence/sqlite.js";

const repository = new SqliteCanvasRepository(config.databasePath);
const service = new CanvasService(repository);
const handler = createHandler(service, config.webDirectory, config.port);
const server = createServer((request, response) => { void handler(request, response); });
server.requestTimeout = 30_000;

server.listen(config.port, config.host, () => {
  console.log(`Excalibur listening on http://${config.host}:${config.port}`);
  console.warn("Authentication is disabled. Local development only; do not expose this service publicly.");
});

function shutdown() {
  const timeout = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  timeout.unref();

  server.close((error) => {
    clearTimeout(timeout);
    repository.close();
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
