import { Hono } from "hono";
import type { CanvasService } from "../../canvas/service.js";
import { readJson } from "../json.js";
import type { HttpEnv } from "../types.js";
import { liveCanvasRoute } from "../../live/route.js";

export function createCanvasRoutes(service: CanvasService) {
  const routes = new Hono<HttpEnv>();

  routes.get("/", (c) => c.json(service.list(c.get("context"))));
  routes.post("/", async (c) =>
    c.json(service.create(c.get("context"), await readJson(c.req)), 201));

  routes.get("/:id", (c) =>
    c.json(service.get(c.get("context"), c.req.param("id"))));
  routes.put("/:id", async (c) =>
    c.json(service.save(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.post("/:id/mutations", async (c) =>
    c.json(service.mutate(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.get("/:id/live", liveCanvasRoute(service));

  routes.all("/", (c) => c.json({ error: "Method not allowed" }, 405));
  routes.all("/:id", (c) => c.json({ error: "Method not allowed" }, 405));
  return routes;
}
