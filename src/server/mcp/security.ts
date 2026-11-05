import { bearerAuthChallengeResponse, getOAuthProtectedResourceMetadataUrl, OAuthError } from "@modelcontextprotocol/server";
import { createMiddleware } from "hono/factory";
import type { McpAuthentication } from "../auth/mcp.js";
import { MCP_ORGANIZATION_SCOPE } from "../auth/mcp.js";
import { ServiceError } from "../canvas/errors.js";
import type { HttpEnv } from "../http/types.js";

export const isMcpEndpoint = (path: string) => path === "/mcp" || path === "/mcp/";
export const isMcpMetadataEndpoint = (path: string) => path === "/.well-known/oauth-protected-resource/mcp" || path === "/.well-known/oauth-protected-resource";

const methods = "GET, POST, DELETE, OPTIONS";
const allowedHeaders = ["authorization", "content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"];

export function createMcpSecurity(auth: McpAuthentication, publicUrl: string) {
  if (auth.resource !== `${publicUrl}/mcp`) throw new Error("MCP resource must match PUBLIC_URL/mcp");
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(auth.resource));
  const metadata = {
    resource: auth.resource,
    authorization_servers: [auth.authorizationServer],
    scopes_supported: [MCP_ORGANIZATION_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Excalibur",
  };
  return createMiddleware<HttpEnv>(async (c, next) => {
    if (isMcpMetadataEndpoint(c.req.path)) {
      // Public, credential-free discovery. This exception must not reach API or
      // live routes. Authorization server discovery stays on PropelAuth itself.
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      c.header("Access-Control-Allow-Headers", allowedHeaders.join(", "));
      if (c.req.method === "OPTIONS") return c.body(null, 204);
      if (c.req.method === "HEAD") { c.header("Content-Type", "application/json"); return c.body(null, 200); }
      if (c.req.method !== "GET") { c.header("Allow", "GET, HEAD, OPTIONS"); return c.json({ error: "Method not allowed" }, 405); }
      return c.json(metadata);
    }
    // MCP uses explicit bearer tokens, never ambient browser cookies. Allow any
    // client origin without changing the web API or WebSocket origin policy.
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version, Mcp-Session-Id");
    if (c.req.method === "OPTIONS") {
      const requestedMethod = c.req.header("access-control-request-method");
      const requestedHeaders = (c.req.header("access-control-request-headers") ?? "").toLowerCase().split(",").map(value => value.trim()).filter(Boolean);
      if ((requestedMethod && !methods.split(", ").includes(requestedMethod)) || requestedHeaders.some(header => !allowedHeaders.includes(header))) {
        throw new ServiceError(403, "MCP preflight not allowed");
      }
      c.header("Access-Control-Allow-Methods", methods);
      c.header("Access-Control-Allow-Headers", allowedHeaders.join(", "));
      return c.body(null, 204);
    }
    try { c.set("context", await auth.authenticate(c.req.header("authorization"), c.req.raw.signal)); }
    catch (error) {
      if (error instanceof OAuthError) {
        const response = bearerAuthChallengeResponse(error, { resourceMetadataUrl, requiredScopes: [MCP_ORGANIZATION_SCOPE] });
        return c.newResponse(response.body, response);
      }
      throw error;
    }
    await next();
  });
}
