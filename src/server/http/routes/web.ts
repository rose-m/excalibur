import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import type { HttpEnv } from "../types.js";

export function createWebRoutes(webDirectory: string) {
  const routes = new Hono<HttpEnv>();
  const index = serveStatic<HttpEnv>({
    root: webDirectory,
    path: "index.html",
    onFound: (_path, c) => { c.header("Cache-Control", "no-cache"); },
  });

  routes.get("/", index);
  routes.get("/canvases/:id", index);
  routes.use("*", serveStatic<HttpEnv>({
    root: webDirectory,
    onFound: (_path, c) => { c.header("Cache-Control", "public, max-age=3600"); },
  }));
  routes.all("*", (c) => c.json({
    error: c.req.method === "GET" || c.req.method === "HEAD"
      ? "Not found. For development, open http://localhost:5173."
      : "Method not allowed",
  }, c.req.method === "GET" || c.req.method === "HEAD" ? 404 : 405));
  return routes;
}
