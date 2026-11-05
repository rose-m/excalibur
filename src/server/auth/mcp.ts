import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { OperationContext } from "./context.js";
import type { Principal } from "./propelauth.js";
import { ServiceError } from "../canvas/errors.js";

const introspectionSchema = z.object({
  active: z.literal(true),
  sub: z.string().min(1),
  org_id: z.string().min(1).nullish(),
  client_id: z.string().min(1),
  aud: z.string(),
  iss: z.string(),
  exp: z.number().int().positive(),
  nbf: z.number().optional(),
});

export type McpAuthentication = {
  resource: string;
  authorizationServer: string;
  authenticate: (authorization: string | undefined, signal?: AbortSignal) => Promise<OperationContext>;
};

export function propelMcpAuthentication(options: {
  authUrl: string;
  resource: string;
  clientId: string;
  clientSecret: string;
  getPrincipal: (userId: string) => Promise<Principal>;
  fetch?: typeof fetch;
  now?: () => number;
}): McpAuthentication {
  const authorizationServer = `${options.authUrl}/oauth/2.1`;
  // Introspection can identify the project by hostname, unlike OAuth discovery,
  // which uses the full /oauth/2.1 issuer URL. Trust only exact configured forms.
  const issuers = new Set([new URL(options.authUrl).host, options.authUrl, authorizationServer]);
  const fetchToken = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const invalid = () => new OAuthError(OAuthErrorCode.InvalidToken, "Invalid or expired MCP access token");
  const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
  return {
    resource: options.resource,
    authorizationServer,
    async authenticate(authorization, signal) {
      // One header, one credential. Reject query tokens, browser cookies, and
      // ambiguous duplicate/comma-separated authorization values.
      const match = /^Bearer ([A-Za-z0-9\-._~+/]+=*)$/i.exec(authorization ?? "");
      if (!match || match[1]!.length > 16_384) throw invalid();
      let claims: unknown;
      try {
        const response = await fetchToken(`${authorizationServer}/introspect`, {
          method: "POST",
          headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ token: match[1]! }),
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
          redirect: "error", // Never send the credential to a redirected host.
          cache: "no-store",
        });
        if (!response.ok) { await response.body?.cancel(); throw new Error("Introspection failed"); }
        claims = await response.json();
      } catch {
        // Do not log tokens, credentials, upstream response bodies, or errors.
        throw new ServiceError(503, "MCP authentication service unavailable");
      }
      const parsed = introspectionSchema.safeParse(claims);
      if (!parsed.success) throw invalid();
      const token = parsed.data;
      if (token.aud !== options.resource || !issuers.has(token.iss)
        || token.exp <= now() / 1000 || (token.nbf !== undefined && token.nbf > now() / 1000)) throw invalid();
      let principal: Principal;
      try { principal = await options.getPrincipal(token.sub); }
      catch (error) {
        if (error instanceof ServiceError && error.status === 401) throw invalid();
        throw new ServiceError(503, "MCP authentication service unavailable");
      }
      if (principal.userId !== token.sub) throw invalid();
      // Each user belongs to one organization. Derive it from current membership,
      // never from a client-selected header or tool argument.
      if (principal.organizations.length !== 1) throw new ServiceError(403, "MCP access requires exactly one organization");
      const organizationId = principal.organizations[0]!.id;
      if (token.org_id && token.org_id !== organizationId) {
        throw new ServiceError(403, "Organization access is no longer available");
      }
      // Account lookup is asynchronous: do not authorize a token that expired
      // while we were waiting for current membership.
      if (token.exp <= now() / 1000) throw invalid();
      return Object.freeze({ userId: token.sub, organizationId });
    },
  };
}
