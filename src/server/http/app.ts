import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { developmentContext } from "../auth/context.js";
import type { CanvasService } from "../canvas/service.js";
import { handleError } from "./errors.js";
import { localRequestsOnly } from "./local-request.js";
import { createCanvasRoutes } from "./routes/canvases.js";
import { healthRoutes } from "./routes/health.js";
import { createWebRoutes } from "./routes/web.js";
import type { HttpEnv } from "./types.js";

export function createApp(service: CanvasService, webDirectory: string, port: number) {
  const app = new Hono<HttpEnv>();

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", localRequestsOnly(port));
  app.use("/api/*", async (c, next) => {
    // Replace this middleware with validated identity/membership later.
    c.set("context", developmentContext);
    await next();
  });
  app.use("/api/*", bodyLimit({
    maxSize: 24 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request exceeds 24 MiB" }, 413),
  }));

  app.route("/health", healthRoutes);
  app.route("/api/canvases", createCanvasRoutes(service));
  // Unknown API routes must never fall through to static web assets.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  app.route("/", createWebRoutes(webDirectory));
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return app;
}
