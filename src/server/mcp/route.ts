import { Hono } from "hono";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { DrawingService } from "../canvas/drawing.js";
import type { CanvasService } from "../canvas/service.js";
import { HeadlessService } from "../render/client.js";
import type { HttpEnv } from "../http/types.js";
import { createCanvasMcpServer } from "./server.js";

export function createMcpRoutes(canvases: CanvasService, publicUrl: string, localOrigins?: ReadonlySet<string>) {
  const routes = new Hono<HttpEnv>();
  const headless = new HeadlessService();
  const drawing = new DrawingService(canvases, headless);
  routes.all("/", async c => {
    // Each exchange gets its own protocol server and validated operation context.
    // Transport lifetime is never canvas lifetime, and no tool chooses a canvas
    // implicitly. The SDK serves modern per-request and legacy stateless HTTP.
    const handler = createMcpHandler(() => createCanvasMcpServer(canvases, drawing, headless, c.get("context"), publicUrl, localOrigins), {
      legacy: "stateless", maxRequestBodySize: 24 * 1024 * 1024,
    });
    try {
      const response = await handler.fetch(c.req.raw);
      // Keep the Hono security/CORS headers on SDK-generated protocol responses.
      const secured = c.newResponse(response.body, response);
      secured.headers.set("Cache-Control", "no-store, no-transform");
      return secured;
    }
    finally { await handler.close(); }
  });
  return { routes, close: () => headless.close() };
}
