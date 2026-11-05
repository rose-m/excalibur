import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { developmentContext } from "../auth/context.js";
import type { CanvasService } from "../canvas/service.js";
import { handleError } from "./errors.js";
import { localRequestPolicy, localRequestsOnly } from "./local-request.js";
import { createCanvasRoutes } from "./routes/canvases.js";
import { healthRoutes } from "./routes/health.js";
import { createWebRoutes } from "./routes/web.js";
import type { HttpEnv } from "./types.js";
import { createMcpRoutes } from "../mcp/route.js";
import type { Authentication } from "../auth/propelauth.js";
import { ConnectionTickets } from "../auth/tickets.js";
import { ServiceError } from "../canvas/errors.js";

export function createApp(service: CanvasService, webDirectory: string, port: number, publicUrl = `http://127.0.0.1:${port}`, network: { allowLocal?: boolean; localAddresses?: string[] } = {}, authentication?: Authentication) {
  const app = new Hono<HttpEnv>();
  const policy = localRequestPolicy(port, network.allowLocal, network.localAddresses);
  const mcp = createMcpRoutes(service, publicUrl, network.allowLocal ? policy.origins : undefined);
  const tickets = new ConnectionTickets();

  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "same-origin");
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use("*", authentication ? async (c, next) => {
    const origin = c.req.header("origin");
    // Hosted login returns via a cross-site top-level GET. Only the public HTML
    // shell permits that navigation; API calls and upgrades remain same-origin.
    const navigation = ["GET", "HEAD"].includes(c.req.method)
      && c.req.header("sec-fetch-mode") === "navigate" && c.req.header("sec-fetch-dest") === "document"
      && (c.req.path === "/" || /^\/canvases\/[^/]+$/.test(c.req.path));
    if ((origin && origin !== publicUrl) || (c.req.header("sec-fetch-site") === "cross-site" && !navigation)) {
      throw new ServiceError(403, "Origin not allowed");
    }
    // Do not trust forwarded headers; the proxy must preserve the public Host.
    if (c.req.header("host") !== new URL(publicUrl).host) throw new ServiceError(403, "Host not allowed");
    await next();
  } : localRequestsOnly(port, policy));
  app.use("*", async (c, next) => {
    if (!authentication) c.set("context", developmentContext);
    else if (c.req.path === "/mcp" || c.req.path.startsWith("/mcp/")) {
      throw new ServiceError(503, "MCP authentication is not configured");
    } else if (c.req.path.startsWith("/api/") && c.req.path !== "/api/auth/config") {
      const match = /^\/api\/canvases\/([^/]+)(?:\/(.*))?$/.exec(c.req.path);
      const canvasId = match ? decodeURIComponent(match[1]!) : undefined;
      if (canvasId && match?.[2] === "live") {
        const origin = c.req.header("origin");
        if (!origin) throw new ServiceError(403, "WebSocket Origin is required");
        if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new ServiceError(400, "WebSocket upgrade required");
        c.set("context", tickets.consume(c.req.query("ticket"), canvasId, origin));
      } else {
        const principal = await authentication.authenticate(c.req.header("authorization"));
        if (c.req.path === "/api/auth/me") {
          if (c.req.method !== "GET") throw new ServiceError(405, "Method not allowed");
          return c.json(principal);
        }
        let organizationId = c.req.header("x-organization-id");
        if (canvasId) {
          // A deep link resolves its own organization, not a tab's selected org.
          organizationId = principal.organizations.find(org => {
            try { service.get({ userId: principal.userId, organizationId: org.id }, canvasId); return true; }
            catch (error) { if (error instanceof ServiceError && error.status === 404) return false; throw error; }
          })?.id;
          if (!organizationId) throw new ServiceError(404, "Canvas not found");
        } else if (!organizationId && principal.organizations.length === 1) organizationId = principal.organizations[0]!.id;
        if (!organizationId || !principal.organizations.some(org => org.id === organizationId)) {
          throw new ServiceError(403, "Select an organization you belong to");
        }
        c.set("context", { userId: principal.userId, organizationId });
      }
    }
    await next();
  });
  app.get("/api/auth/config", c => c.json(authentication ? { mode: "propelauth", authUrl: authentication.authUrl } : { mode: "development" }));
  app.get("/api/auth/me", c => c.json({ userId: developmentContext.userId, organizations: [{ id: developmentContext.organizationId, name: "Local development" }] }));
  app.use("/api/*", bodyLimit({
    maxSize: 24 * 1024 * 1024,
    onError: (c) => c.json({ error: "Request exceeds 24 MiB" }, 413),
  }));
  app.post("/api/canvases/:id/live-ticket", c => {
    const origin = c.req.header("origin");
    if (!origin) throw new ServiceError(403, "Origin is required");
    const context = c.get("context");
    service.get(context, c.req.param("id"));
    return c.json(tickets.issue(context, c.req.param("id"), origin), 201);
  });

  app.route("/health", healthRoutes);
  app.route("/api/canvases", createCanvasRoutes(service));
  app.route("/mcp", mcp.routes);
  // Unknown API routes must never fall through to static web assets.
  app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));
  app.route("/", createWebRoutes(webDirectory));
  app.onError(handleError);
  app.notFound((c) => c.json({ error: "Not found" }, 404));
  return Object.assign(app, { closeMcp: mcp.close });
}
