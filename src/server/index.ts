import { createServer } from "node:http";
import { config } from "./config.js";

// Bootstrap only: application routes and integrations are not implemented yet.
const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health/live") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok" }));
    return;
  }

  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(config.port, config.host, () => {
  console.log(`Excalibur listening on http://${config.host}:${config.port}`);
});

function shutdown() {
  const timeout = setTimeout(() => {
    console.error("Graceful shutdown timed out");
    process.exit(1);
  }, 10_000);
  timeout.unref();

  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
