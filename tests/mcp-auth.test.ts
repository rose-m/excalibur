import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { auth as authorize, Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import type { OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens } from "@modelcontextprotocol/client";
import { OAuthError } from "@modelcontextprotocol/server";
import { WebSocket } from "ws";
import { MCP_ORGANIZATION_SCOPE, propelMcpAuthentication } from "../src/server/auth/mcp.js";
import type { Authentication, Principal } from "../src/server/auth/propelauth.js";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";

const authUrl = "https://auth.example";
const aliceA = { userId: "alice", organizationId: "org-a" };
const charlieB = { userId: "charlie", organizationId: "org-b" };
const bobA = { userId: "bob", organizationId: "org-a" };

function fixture(publicUrl = "https://draw.example") {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const resource = `${publicUrl}/mcp`;
  const now = 1_800_000_000_000;
  const principals: Record<string, Principal> = {
    alice: { userId: "alice", organizations: [{ id: "org-a", name: "A" }] },
    bob: { userId: "bob", organizations: [{ id: "org-a", name: "A" }] },
    charlie: { userId: "charlie", organizations: [{ id: "org-b", name: "B" }] },
  };
  const claims = (changes: Record<string, unknown> = {}) => ({
    active: true, sub: "alice", org_id: "org-a", scope: MCP_ORGANIZATION_SCOPE, client_id: "agent-client", aud: resource,
    // Live PropelAuth introspection uses a bare project hostname for iss.
    iss: new URL(authUrl).host, exp: now / 1000 + 3600, ...changes,
  });
  const tokens: Record<string, unknown> = {
    "alice-a": claims(), "charlie-b": claims({ sub: "charlie", org_id: "org-b" }), "bob-a": claims({ sub: "bob" }),
  };
  const state = { status: 200, malformed: false, offline: false, lookupOffline: false, requests: [] as { url: string; init: RequestInit }[] };
  const authentication: Authentication = {
    authUrl,
    async getPrincipal(userId) {
      if (state.lookupOffline) throw new ServiceError(503, "Upstream unavailable");
      if (!principals[userId]) throw new ServiceError(401, "Account unavailable");
      return principals[userId]!;
    },
    async authenticate(header) {
      if (header !== "Bearer browser-alice") throw new ServiceError(401, "Browser login required");
      return this.getPrincipal("alice");
    },
  };
  const mcpAuthentication = propelMcpAuthentication({
    authUrl, resource, clientId: "validation-client", clientSecret: "validation-secret",
    getPrincipal: userId => authentication.getPrincipal(userId), now: () => now,
    fetch: async (input, init) => {
      state.requests.push({ url: String(input), init: init! });
      if (state.offline) throw new Error("Sensitive upstream error: token and validation-secret must not be exposed");
      if (state.malformed) return new Response("not JSON");
      const token = new URLSearchParams(init!.body as URLSearchParams).get("token")!;
      return Response.json(tokens[token] ?? { active: false }, { status: state.status });
    },
  });
  const app = createApp(service, "dist/web", 3000, publicUrl, {}, authentication, mcpAuthentication);
  function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("host", new URL(publicUrl).host);
    return app.request(`${publicUrl}${path}`, { ...init, headers });
  }
  return { repository, service, resource, now, claims, principals, tokens, state, authentication, mcpAuthentication, app, request,
    close: async () => { await app.closeMcp(); repository.close(); } };
}

test("MCP introspection sends the OAuth bearer with separate Request Validation credentials", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await f.mcpAuthentication.authenticate("Bearer alice-a"), aliceA);
    const request = f.state.requests[0]!;
    assert.equal(request.url, `${authUrl}/oauth/2.1/introspect`);
    assert.equal(request.init.method, "POST");
    const headers = new Headers(request.init.headers);
    assert.equal(headers.get("authorization"), `Basic ${Buffer.from("validation-client:validation-secret").toString("base64")}`);
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(request.init.body as URLSearchParams).get("token"), "alice-a");
    assert.equal(request.init.redirect, "error");
    assert(request.init.signal);
    for (const iss of [authUrl, `${authUrl}/oauth/2.1`]) {
      f.tokens["url-issuer"] = f.claims({ iss });
      assert.deepEqual(await f.mcpAuthentication.authenticate("bearer url-issuer"), aliceA);
    }
  } finally { await f.close(); }
});

test("MCP rejects malformed headers, inactive/expired tokens, wrong audience/issuer and missing user identity", async () => {
  const f = fixture();
  try {
    for (const header of [undefined, "Basic alice-a", "Bearer", "Bearer alice-a extra", "Bearer alice-a,Bearer bob-a", `Bearer ${"a".repeat(16_385)}`]) {
      await assert.rejects(() => f.mcpAuthentication.authenticate(header), error => error instanceof OAuthError && error.code === "invalid_token");
    }
    assert.equal(f.state.requests.length, 0);
    const cases = [
      { active: false }, { active: "true" }, { exp: f.now / 1000 }, { exp: f.now / 1000 - 1 }, { exp: undefined }, { exp: "9999999999" },
      { nbf: f.now / 1000 + 60 }, { aud: "https://other.example/mcp" }, { aud: `${f.resource}/` }, { aud: [f.resource] },
      { iss: "https://evil.example" }, { iss: "evil.example" }, { iss: "auth.example.evil.example" }, { iss: "https://auth.example.evil.example" },
      { iss: `${authUrl}/untrusted` }, { sub: undefined }, { org_id: "" }, { client_id: undefined },
    ];
    for (const changes of cases) {
      f.tokens.invalid = f.claims(changes);
      const response = await f.request("/mcp", { method: "POST", headers: { authorization: "Bearer invalid" } });
      assert.equal(response.status, 401, JSON.stringify(changes));
      assert.match(response.headers.get("www-authenticate")!, /error="invalid_token"/);
      assert.match(response.headers.get("www-authenticate")!, /resource_metadata="https:\/\/draw.example\/\.well-known\/oauth-protected-resource\/mcp"/);
    }
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await f.request("/mcp", { method });
      assert.equal(response.status, 401);
    }
    assert.equal((await f.request("/mcp?access_token=alice-a", { headers: { cookie: "access_token=alice-a" } })).status, 401);
    assert.equal((await f.request("/mcp/", { method: "POST" })).status, 401);
    assert.equal((await f.request("/mcp", { headers: { authorization: "Bearer browser-alice" } })).status, 401);
  } finally { await f.close(); }
});

test("MCP rechecks token expiry after asynchronous account lookup, including the exact expiry boundary", async () => {
  const start = 1_800_000_000_000;
  for (const elapsed of [0, 999, 1000, 1001]) {
    let clock = start;
    const authentication = propelMcpAuthentication({
      authUrl, resource: "https://draw.example/mcp", clientId: "validation-client", clientSecret: "validation-secret",
      now: () => clock,
      fetch: async () => Response.json({
        active: true, sub: "alice", org_id: "org-a", scope: MCP_ORGANIZATION_SCOPE, client_id: "agent-client", aud: "https://draw.example/mcp",
        iss: new URL(authUrl).host, exp: start / 1000 + 1,
      }),
      async getPrincipal() {
        await Promise.resolve();
        clock = start + elapsed;
        return { userId: "alice", organizations: [{ id: "org-a", name: "A" }] };
      },
    });
    if (elapsed < 1000) {
      assert.deepEqual(await authentication.authenticate("Bearer access-token"), aliceA);
    } else {
      await assert.rejects(() => authentication.authenticate("Bearer access-token"), error => error instanceof OAuthError && error.code === "invalid_token");
    }
  }
});

test("MCP requires the organization scope and advertises it in OAuth challenges", async () => {
  const f = fixture();
  try {
    for (const value of [undefined, "", "mcp:tenant", "unrelated"]) {
      f.tokens.noscope = f.claims({ scope: value, users_org_permissions: [] });
      const denied = await f.request("/mcp", { headers: { authorization: "Bearer noscope" } });
      assert.equal(denied.status, 403);
      assert.match(denied.headers.get("www-authenticate")!, /error="insufficient_scope"/);
      assert.match(denied.headers.get("www-authenticate")!, /scope="canvases:access"/);
    }
    f.tokens.scoped = f.claims({ scope: `other ${MCP_ORGANIZATION_SCOPE}`, users_org_permissions: [] });
    assert.deepEqual(await f.mcpAuthentication.authenticate("Bearer scoped"), aliceA);
    const response = await f.request("/mcp", { headers: { origin: "https://inspector.example" } });
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate")!, /scope="canvases:access"/);
    assert.match(response.headers.get("access-control-expose-headers")!, /WWW-Authenticate/);
  } finally { await f.close(); }
});

test("MCP uses the token-selected org, supports multiple memberships and never guesses missing orgs", async () => {
  const f = fixture();
  try {
    f.tokens["user-only"] = f.claims({ org_id: undefined });
    await assert.rejects(() => f.mcpAuthentication.authenticate("Bearer user-only"), error => error instanceof OAuthError && error.code === "invalid_token");
    f.tokens.mismatch = f.claims({ org_id: "org-b" });
    await assert.rejects(() => f.mcpAuthentication.authenticate("Bearer mismatch"), /Organization access/);
    f.principals.alice = { userId: "alice", organizations: [{ id: "org-a", name: "A" }, { id: "org-b", name: "B" }] };
    assert.deepEqual(await f.mcpAuthentication.authenticate("Bearer alice-a"), aliceA);
    assert.deepEqual(await f.mcpAuthentication.authenticate("Bearer mismatch"), { userId: "alice", organizationId: "org-b" });
    f.tokens["single-org"] = f.claims({ sub: "bob", org_id: undefined });
    await assert.rejects(() => f.mcpAuthentication.authenticate("Bearer single-org"), OAuthError);
    f.tokens["single-org-null"] = f.claims({ sub: "bob", org_id: null });
    await assert.rejects(() => f.mcpAuthentication.authenticate("Bearer single-org-null"), OAuthError);
    f.principals.bob = { userId: "bob", organizations: [] };
    await assert.rejects(() => f.mcpAuthentication.authenticate("Bearer bob-a"), /Organization access/);
  } finally { await f.close(); }
});

test("MCP account/membership checks and provider failures deny access without exposing upstream details", async () => {
  const f = fixture();
  const call = () => f.request("/mcp", { headers: { authorization: "Bearer alice-a" } });
  try {
    f.principals.alice = { userId: "alice", organizations: [{ id: "org-b", name: "B" }] };
    assert.equal((await call()).status, 403);
    delete f.principals.alice;
    assert.equal((await call()).status, 401, "disabled, locked and deleted accounts must fail closed");
    f.state.lookupOffline = true;
    assert.equal((await call()).status, 503);
    f.state.lookupOffline = false;
    for (const status of [401, 403, 500, 503]) {
      f.state.status = status;
      const response = await call();
      assert.equal(response.status, 503, "an introspection credential/service error is not an expired user token");
      assert.doesNotMatch(await response.text(), /validation-secret|alice-a/);
    }
    f.state.status = 200;
    f.state.malformed = true;
    assert.equal((await call()).status, 503);
    f.state.malformed = false;
    f.state.offline = true;
    const response = await call();
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /Sensitive|validation-secret|alice-a/);
  } finally { await f.close(); }
});

test("MCP allows every origin while retaining bearer auth and web API/WebSocket policies", async () => {
  const f = fixture();
  try {
    const foreign = { origin: "https://any-client.example", "sec-fetch-site": "cross-site" };
    for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
      const response = await f.request(path, { headers: foreign });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
      assert.deepEqual(await response.json(), {
        resource: f.resource, authorization_servers: [`${authUrl}/oauth/2.1`], scopes_supported: [MCP_ORGANIZATION_SCOPE], bearer_methods_supported: ["header"], resource_name: "Excalibur",
      });
      assert.equal((await f.request(path, { method: "OPTIONS", headers: foreign })).status, 204);
      const head = await f.request(path, { method: "HEAD", headers: foreign });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
      assert.equal((await f.request(path, { method: "POST", headers: foreign })).status, 405);
    }
    assert.equal(f.state.requests.length, 0, "discovery must not introspect or require login");
    assert.equal((await f.app.request(`${f.resource}/../.well-known/oauth-protected-resource/mcp`, { headers: { host: "evil.example" } })).status, 403);
    const cors = { origin: "https://inspector.example", "sec-fetch-site": "cross-site" };
    const preflight = await f.request("/mcp", { method: "OPTIONS", headers: {
      ...cors, "access-control-request-method": "POST", "access-control-request-headers": "Authorization, Content-Type, MCP-Protocol-Version",
    } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    assert.equal(preflight.headers.get("access-control-allow-credentials"), null);
    const challenge = await f.request("/mcp", { method: "POST", headers: cors });
    assert.equal(challenge.status, 401);
    assert.equal(challenge.headers.get("access-control-allow-origin"), "*");
    assert.equal((await f.request("/mcp", { method: "OPTIONS", headers: { ...cors, "access-control-request-headers": "x-untrusted-header" } })).status, 403);
    for (const headers of [foreign, { origin: "null" }, { "sec-fetch-site": "cross-site" }, {}]) {
      const response = await f.request("/mcp", { headers });
      assert.equal(response.status, 401, "all origins still require a bearer token");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(response.headers.get("access-control-allow-credentials"), null);
    }
    for (const path of ["/api/auth/config", "/api/canvases", "/api/canvases/example/live", "/.well-known/oauth-protected-resource/other"]) {
      assert.equal((await f.request(path, { headers: { ...cors, authorization: "Bearer browser-alice" } })).status, 403, path);
    }
  } finally { await f.close(); }
});

test("official SDK performs strict discovery, DCR, PKCE and code exchange against a simulated PropelAuth issuer", async () => {
  const f = fixture();
  let client: StoredOAuthClientInformation | undefined;
  let tokens: StoredOAuthTokens | undefined;
  let discovery: OAuthDiscoveryState | undefined;
  let verifier = "";
  let redirect: URL | undefined;
  const requests: string[] = [];
  const provider: OAuthClientProvider = {
    redirectUrl: "http://127.0.0.1:19876/callback",
    clientMetadata: { client_name: "Integration test", redirect_uris: ["http://127.0.0.1:19876/callback"], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" },
    state: () => "test-state",
    clientInformation: () => client,
    saveClientInformation: value => { client = value; },
    tokens: () => tokens,
    saveTokens: value => { tokens = value; },
    redirectToAuthorization: value => { redirect = value; },
    saveCodeVerifier: value => { verifier = value; },
    codeVerifier: () => verifier,
    saveDiscoveryState: value => { discovery = value; },
    discoveryState: () => discovery,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.origin === "https://draw.example") return f.request(url.pathname, init);
    if (url.href === `${authUrl}/.well-known/oauth-authorization-server/oauth/2.1`) return Response.json({
      issuer: `${authUrl}/oauth/2.1`, authorization_endpoint: `${authUrl}/oauth/2.1/authorize`, token_endpoint: `${authUrl}/oauth/2.1/token`,
      registration_endpoint: `${authUrl}/oauth/2.1/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], scopes_supported: [MCP_ORGANIZATION_SCOPE], authorization_response_iss_parameter_supported: true,
    });
    if (url.pathname === "/oauth/2.1/register") {
      const registration = JSON.parse(init!.body as string);
      return Response.json({ ...registration, client_id: "registered-client" });
    }
    if (url.pathname === "/oauth/2.1/token") {
      const params = new URLSearchParams(init!.body as URLSearchParams);
      assert.equal(params.get("resource"), f.resource);
      assert.equal(params.get("code_verifier"), verifier);
      assert.equal(params.get("code"), "test-code");
      return Response.json({ access_token: "alice-a", token_type: "Bearer", expires_in: 3600 });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
  try {
    const challenge = await f.request("/mcp", { method: "POST" });
    const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get("www-authenticate")!)![1]!;
    assert.equal(await authorize(provider, { serverUrl: f.resource, resourceMetadataUrl: new URL(metadataUrl), fetchFn }), "REDIRECT");
    assert(redirect);
    assert.equal(redirect.origin, authUrl);
    assert.equal(redirect.pathname, "/oauth/2.1/authorize");
    assert.equal(redirect.searchParams.get("resource"), f.resource);
    assert.equal(redirect.searchParams.get("scope"), MCP_ORGANIZATION_SCOPE);
    assert.equal(redirect.searchParams.get("state"), "test-state");
    assert.equal(redirect.searchParams.get("code_challenge_method"), "S256");
    assert.equal(redirect.searchParams.get("code_challenge"), createHash("sha256").update(verifier).digest("base64url"));
    await assert.rejects(() => authorize(provider, { serverUrl: f.resource, authorizationCode: "test-code", iss: "https://evil.example", fetchFn }));
    assert.equal(await authorize(provider, { serverUrl: f.resource, authorizationCode: "test-code", iss: `${authUrl}/oauth/2.1`, fetchFn }), "AUTHORIZED");
    assert.equal(tokens?.access_token, "alice-a");
    assert(requests.includes(`${authUrl}/.well-known/oauth-authorization-server/oauth/2.1`));
    assert.deepEqual(await f.mcpAuthentication.authenticate(`Bearer ${tokens!.access_token}`), aliceA);
  } finally { await f.close(); }
});

test("official authenticated MCP clients enforce user/org boundaries and edits reach an authenticated live browser", { timeout: 15_000 }, async () => {
  let app!: ReturnType<typeof createApp>;
  const live = createLiveServer();
  const http = createAdaptorServer({ fetch: (request, env) => app.fetch(request, env), websocket: live.adapter });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const publicUrl = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const f = fixture(publicUrl);
  app = f.app;
  const clients: Client[] = [];
  let socket: WebSocket | undefined;
  async function connect(token: string) {
    const client = new Client({ name: "authenticated-test", version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(f.resource), {
      requestInit: { headers: { authorization: `Bearer ${token}`, origin: "https://inspector.example", "sec-fetch-site": "cross-site" } },
      fetch: async (input, init) => {
        const response = await fetch(input, init);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.match(response.headers.get("cache-control")!, /no-store/);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        return response;
      },
    }));
    return client;
  }
  try {
    f.principals.alice = { userId: "alice", organizations: [{ id: "org-a", name: "A" }, { id: "org-b", name: "B" }] };
    f.tokens["alice-b"] = f.claims({ org_id: "org-b" });
    const a = await connect("alice-a");
    assert.equal((await a.listTools()).tools.length, 30);
    const created = await a.callTool({ name: "create_canvas", arguments: { title: "Agent private" } });
    assert(!created.isError);
    const canvas = created.structuredContent as { canvasId: string; creatorUserId: string; organizationId: string; url: string };
    assert.equal(canvas.creatorUserId, "alice");
    assert.equal(canvas.organizationId, "org-a", "the token selects the organization, not the user's first membership");
    assert.equal(canvas.url, `${publicUrl}/canvases/${canvas.canvasId}`);
    const aliceB = await connect("alice-b");
    const createdB = await aliceB.callTool({ name: "create_canvas", arguments: { title: "Alice in B" } });
    assert(!createdB.isError);
    const canvasB = createdB.structuredContent as { canvasId: string; organizationId: string };
    assert.equal(canvasB.organizationId, "org-b");
    assert((await a.callTool({ name: "get_canvas", arguments: { canvasId: canvasB.canvasId } })).isError);
    assert((await aliceB.callTool({ name: "get_canvas", arguments: { canvasId: canvas.canvasId } })).isError);
    const browserB = await f.request("/api/canvases", { headers: { authorization: "Bearer browser-alice", "x-organization-id": "org-b" } });
    assert.deepEqual((await browserB.json() as { id: string }[]).map(item => item.id), [canvasB.canvasId]);
    const other = f.service.create(charlieB, { title: "Other organization" });
    const bobPrivate = f.service.create(bobA, { title: "Bob private" });
    const bob = await connect("bob-a");
    for (const [client, id] of [[a, other.id], [a, bobPrivate.id], [bob, canvas.canvasId]] as const) {
      for (const name of ["get_canvas", "get_canvas_screenshot"]) {
        const result = await client.callTool({ name, arguments: { canvasId: id } });
        assert(result.isError);
        assert.equal((result.structuredContent as { error: { status: number } }).error.status, 404);
      }
    }
    const list = await a.callTool({ name: "list_canvases", arguments: {} });
    assert.deepEqual((list.structuredContent as { canvases: { id: string }[] }).canvases.map(item => item.id), [canvas.canvasId]);
    const browser = await f.request(`/api/canvases/${canvas.canvasId}/live-ticket`, {
      method: "POST", headers: { authorization: "Bearer browser-alice", "x-organization-id": "org-a", origin: publicUrl },
    });
    assert.equal(browser.status, 201);
    const ticket = (await browser.json() as { ticket: string }).ticket;
    socket = new WebSocket(`${publicUrl.replace("http:", "ws:")}/api/canvases/${canvas.canvasId}/live?ticket=${ticket}`, { origin: publicUrl });
    await once(socket, "message");
    const update = once(socket, "message");
    const edited = await a.callTool({ name: "apply_mutations", arguments: {
      canvasId: canvas.url, expectedRevision: 0, elements: [{ id: "agent-element", type: "rectangle", version: 1, versionNonce: 1, index: "a0", isDeleted: false }],
    } });
    assert(!edited.isError, JSON.stringify(edited));
    const [message] = await update;
    assert.equal(JSON.parse(message.toString()).update.elements[0].id, "agent-element");
    await a.close();
    const reconnected = await connect("alice-a");
    assert(!(await reconnected.callTool({ name: "get_canvas", arguments: { canvasId: canvas.url } })).isError);
    const b = await connect("charlie-b");
    assert(!(await b.callTool({ name: "get_canvas", arguments: { canvasId: other.id } })).isError);
    f.tokens["alice-a"] = { active: false };
    await assert.rejects(() => reconnected.listTools(), "each exchange must re-introspect, even on an existing client");
    f.tokens["alice-a"] = f.claims();
    f.principals.alice = { userId: "alice", organizations: [{ id: "org-b", name: "B" }] };
    await assert.rejects(() => reconnected.callTool({ name: "create_canvas", arguments: { title: "Must not create" } }));
    assert.equal((await f.request("/api/canvases", { headers: { authorization: "Bearer charlie-b" } })).status, 401, "MCP OAuth bearers are not browser API tokens");
  } finally {
    socket?.terminate();
    for (const socket of live.sockets.clients) socket.terminate();
    for (const client of clients) await client.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await f.close();
  }
});

test("development proxies preserve the canonical public MCP host for discovery and authenticated SDK calls", { timeout: 15_000 }, async () => {
  const { createServer: createViteServer } = await import("vite");
  const { default: config } = await import("../vite.config.js");
  let app!: ReturnType<typeof createApp>;
  const backend = createAdaptorServer({ fetch: request => app.fetch(request) });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  const target = `http://127.0.0.1:${(backend.address() as AddressInfo).port}`;
  const proxy = Object.fromEntries(Object.entries(config.server!.proxy!).map(([path, options]) => {
    assert.equal(typeof options, "object");
    assert.equal((options as { changeOrigin: boolean }).changeOrigin, false);
    return [path, { ...(options as object), target }];
  }));
  const vite = await createViteServer({
    configFile: false, logLevel: "silent", optimizeDeps: { noDiscovery: true, include: [] },
    server: { host: "127.0.0.1", port: 0, strictPort: true, hmr: false, watch: null, proxy },
  });
  const client = new Client({ name: "vite-proxy-test", version: "1" });
  let f: ReturnType<typeof fixture> | undefined;
  try {
    await vite.listen();
    const publicUrl = `http://127.0.0.1:${(vite.httpServer!.address() as AddressInfo).port}`;
    f = fixture(publicUrl);
    app = f.app;
    const discovery = await fetch(`${publicUrl}/.well-known/oauth-protected-resource/mcp`);
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).resource, `${publicUrl}/mcp`);
    const challenge = await fetch(`${publicUrl}/mcp`, { method: "POST" });
    assert.equal(challenge.status, 401);
    assert.match(challenge.headers.get("www-authenticate")!, new RegExp(`resource_metadata="${publicUrl}`));
    assert.equal((await fetch(`${publicUrl}/health/ready`)).status, 200);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), { requestInit: { headers: { authorization: "Bearer alice-a" } } }));
    assert.equal((await client.listTools()).tools.length, 30);
  } finally {
    await client.close();
    await vite.close();
    await new Promise<void>(resolve => backend.close(() => resolve()));
    await f?.close();
  }
});
