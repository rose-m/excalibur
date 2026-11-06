import { Hono } from "hono";
import type { CanvasService } from "../../canvas/service.js";
import { readJson } from "../json.js";
import type { HttpEnv } from "../types.js";
import { liveCanvasRoute } from "../../live/route.js";
import type { Authentication } from "../../auth/propelauth.js";
import type { CanvasListItem } from "../../../shared/canvas.js";
import { developmentContext } from "../../auth/context.js";

export function createCanvasRoutes(service: CanvasService, authentication?: Authentication) {
  const routes = new Hono<HttpEnv>();

  routes.get("/", async c => {
    // Derive lookup IDs exclusively from the already-authorized canvas list.
    const canvases = service.list(c.get("context"));
    const ownerIds = [...new Set(canvases.map(canvas => canvas.creatorUserId))];
    let names: ReadonlyMap<string, string> = new Map();
    if (ownerIds.length && authentication?.getUserDisplayNames) {
      try { names = await authentication.getUserDisplayNames(ownerIds); }
      catch { /* Names are optional display metadata, not an authorization check. */ }
    } else if (!authentication) {
      names = new Map([[developmentContext.userId, "Local development"]]);
    }
    const items: CanvasListItem[] = canvases.map(canvas => ({ ...canvas, ownerName: names.get(canvas.creatorUserId) ?? null }));
    return c.json(items);
  });
  routes.post("/", async (c) =>
    c.json(service.create(c.get("context"), await readJson(c.req)), 201));

  routes.get("/:id", (c) =>
    c.json(service.get(c.get("context"), c.req.param("id"))));
  routes.patch("/:id", async c =>
    c.json(service.rename(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.delete("/:id", async c =>
    c.json(service.delete(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.put("/:id", async (c) =>
    c.json(service.save(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.post("/:id/mutations", async (c) =>
    c.json(service.mutate(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.patch("/:id/visibility", async c =>
    c.json(service.setVisibility(c.get("context"), c.req.param("id"), await readJson(c.req))));
  routes.get("/:id/live", liveCanvasRoute(service));
  routes.get("/:id/comments", c => c.json(service.comments.get(c.get("context"), c.req.param("id"))));
  routes.post("/:id/comments", async c => c.json(service.comments.create(c.get("context"), c.req.param("id"), await readJson(c.req)), 201));
  routes.delete("/:id/comments/:commentId", c => c.json(service.comments.resolve(c.get("context"), c.req.param("id"), c.req.param("commentId"))));
  routes.patch("/:id/comments/:commentId", async c => c.json(service.comments.edit(c.get("context"), c.req.param("id"), c.req.param("commentId"), await readJson(c.req))));

  routes.all("/", (c) => c.json({ error: "Method not allowed" }, 405));
  routes.all("/:id", (c) => c.json({ error: "Method not allowed" }, 405));
  return routes;
}
