import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket } from "ws";
import { ConnectionTickets } from "../src/server/auth/tickets.js";
import type { Authentication, Principal } from "../src/server/auth/propelauth.js";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import { createTestRepository } from "./postgres.js";
import type { CanvasDocument } from "../src/shared/canvas.js";

const context = { userId: "alice", organizationId: "org-a" };

test("connection tickets expire, are single-use and bind canvas, organization, user and origin", () => {
  let now = 100;
  const tickets = new ConnectionTickets(() => now);
  const issue = () => tickets.issue(context, "canvas", "https://app.example").ticket;
  const first = issue();
  assert.deepEqual(tickets.consume(first, "canvas", "https://app.example"), context);
  assert.throws(() => tickets.consume(first, "canvas", "https://app.example"), /invalid or expired/);
  assert.throws(() => tickets.consume(issue(), "other", "https://app.example"), /invalid or expired/);
  assert.throws(() => tickets.consume(issue(), "canvas", "https://evil.example"), /invalid or expired/);
  assert.throws(() => tickets.consume(undefined, "canvas", "https://app.example"), /required/);
  const expired = issue();
  now += 30_000;
  assert.throws(() => tickets.consume(expired, "canvas", "https://app.example"), /invalid or expired/);
  for (let i = 0; i < 20; i++) issue();
  assert.throws(issue, /Too many pending/);
  now += 30_000;
  assert.doesNotThrow(issue, "expired entries must not exhaust capacity");
});

function authentication() {
  const principals: Record<string, Principal> = {
    alice: { userId: "alice", organizations: [{ id: "org-a", name: "A" }] },
    multi: { userId: "multi", organizations: [{ id: "org-a", name: "A" }, { id: "org-b", name: "B" }] },
    bob: { userId: "bob", organizations: [{ id: "org-a", name: "A" }] },
    outsider: { userId: "outsider", organizations: [{ id: "org-c", name: "C" }] },
    noorg: { userId: "noorg", organizations: [] },
  };
  const auth: Authentication = {
    authUrl: "https://auth.example",
    async getPrincipal(userId) {
      const principal = principals[userId];
      if (!principal) throw new ServiceError(401, "Account unavailable");
      return principal;
    },
    async authenticate(header) {
      const principal = principals[header?.replace(/^Bearer /, "") ?? ""];
      if (!principal) throw new ServiceError(401, "Please sign in again");
      return principal;
    },
  };
  return { auth, principals };
}

test("authenticated HTTP enforces identity, current org membership, private access, origins and MCP isolation", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const { auth, principals } = authentication();
  const origin = "https://app.example";
  const app = createApp(service, "dist/web", 3000, origin, {}, auth);
  function request(path: string, user?: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("host", "app.example");
    if (user) headers.set("authorization", `Bearer ${user}`);
    return app.request(`${origin}${path}`, { ...init, headers });
  }
  try {
    assert.equal((await request("/health/ready")).status, 200);
    const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
    assert.notEqual((await request("/", undefined, { headers: navigation })).status, 403, "hosted login must be able to return to the public app shell");
    assert.notEqual((await request("/canvases/example", undefined, { headers: navigation })).status, 403);
    assert.equal((await request("/api/auth/config", undefined, { headers: navigation })).status, 403);
    assert.deepEqual(await (await request("/api/auth/config")).json(), { mode: "propelauth", authUrl: auth.authUrl });
    assert.equal((await request("/api/canvases")).status, 401);
    assert.equal((await request("/api/canvases", "expired")).status, 401);
    assert.equal((await request("/api/canvases", "alice")).status, 200, "the user's org is resolved without a selection header");
    assert.equal((await request("/api/canvases", "multi")).status, 403, "multi-org users must select an org");
    assert.equal((await request("/api/canvases", "multi", { headers: { "x-organization-id": "org-a" } })).status, 200);
    assert.equal((await request("/api/canvases", "multi", { headers: { "x-organization-id": "org-b" } })).status, 200);
    assert.equal((await request("/api/auth/me", "noorg")).status, 200);
    assert.equal((await request("/api/canvases", "noorg")).status, 403);
    assert.equal((await request("/api/canvases", "alice", { headers: { "x-organization-id": "org-c" } })).status, 403, "selection requires current membership");
    const created = await request("/api/canvases", "alice", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Private" }),
    });
    assert.equal(created.status, 201);
    const canvas = await created.json() as CanvasDocument;
    assert.equal(canvas.creatorUserId, "alice");
    assert.equal(canvas.organizationId, "org-a");
    assert.equal((await request(`/api/canvases/${canvas.id}`, "alice", { headers: { "x-organization-id": "org-b" } })).status, 403);
    assert.equal((await request(`/api/canvases/${canvas.id}`, "multi")).status, 403);
    for (const user of ["bob", "outsider"]) {
      assert.equal((await request(`/api/canvases/${canvas.id}`, user)).status, 404);
      assert.equal((await request(`/api/canvases/${canvas.id}/comments`, user)).status, 404);
      assert.equal((await request(`/api/canvases/${canvas.id}/live-ticket`, user, { method: "POST", headers: { origin } })).status, 404);
    }
    assert.equal((await request(`/api/canvases/${canvas.id}/live-ticket`, "alice", { method: "POST" })).status, 403);
    const ticket = await request(`/api/canvases/${canvas.id}/live-ticket`, "alice", { method: "POST", headers: { origin } });
    assert.equal(ticket.status, 201);
    assert.equal(ticket.headers.get("cache-control"), "no-store");
    assert.equal((await request(`/api/canvases/${canvas.id}/live`, "alice", { headers: { origin, upgrade: "websocket" } })).status, 401, "bearer alone must not bypass tickets");
    const encoded = canvas.id.replace(/./, char => `%${char.charCodeAt(0).toString(16)}`);
    assert.equal((await request(`/api/canvases/${encoded}/live`, "alice", { headers: { origin, upgrade: "websocket" } })).status, 401);
    for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
      assert.equal((await request("/api/canvases", "bob", { headers })).status, 403);
    }
    assert.equal((await app.request(`${origin}/health/ready`, { headers: { host: "evil.example" } })).status, 403);
    assert.equal((await request("/mcp", "alice", { method: "POST" })).status, 503);
    principals.alice = { userId: "alice", organizations: [{ id: "org-b", name: "B" }] };
    assert.equal((await request(`/api/canvases/${canvas.id}`, "alice")).status, 404, "even creators lose access when removed from org");
    assert.equal((await request(`/api/canvases/${canvas.id}/live-ticket`, "alice", { method: "POST", headers: { origin } })).status, 404);
  } finally { await app.closeMcp(); await repository.close(); }
});

test("multi-org browser requests isolate the same user's canvases, comments and live tickets", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const { auth, principals } = authentication();
  const origin = "https://app.example";
  const app = createApp(service, "dist/web", 3000, origin, {}, auth);
  const request = (path: string, organizationId: string, init: RequestInit = {}) => app.request(`${origin}${path}`, {
    ...init, headers: { host: "app.example", origin, authorization: "Bearer multi", "x-organization-id": organizationId, ...init.headers },
  });
  try {
    const canvases: CanvasDocument[] = [];
    for (const org of ["org-a", "org-b"]) {
      const response = await request("/api/canvases", org, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: org }),
      });
      assert.equal(response.status, 201);
      const canvas = await response.json() as CanvasDocument;
      assert.equal(canvas.organizationId, org);
      assert.equal(canvas.creatorUserId, "multi");
      canvases.push(canvas);
    }
    for (const canvas of canvases) {
      const other = canvas.organizationId === "org-a" ? "org-b" : "org-a";
      const listed = await (await request("/api/canvases", canvas.organizationId)).json() as CanvasDocument[];
      assert.deepEqual(listed.map(item => item.id), [canvas.id]);
      assert.equal((await request(`/api/canvases/${canvas.id}`, other)).status, 404);
      assert.equal((await request(`/api/canvases/${canvas.id}/comments`, other)).status, 404);
      assert.equal((await request(`/api/canvases/${canvas.id}/live-ticket`, other, { method: "POST" })).status, 404);
      assert.equal((await request(`/api/canvases/${canvas.id}/live-ticket`, canvas.organizationId, { method: "POST" })).status, 201);
    }
    principals.multi = { userId: "multi", organizations: [{ id: "org-b", name: "B" }] };
    assert.equal((await request("/api/canvases", "org-a")).status, 403, "remembered selections cannot retain revoked access");
    assert.equal((await request("/api/canvases", "org-b")).status, 200);
  } finally { await app.closeMcp(); await repository.close(); }
});

test("WebSockets require fresh tickets; replay and cross-canvas upgrades are rejected", { timeout: 10_000 }, async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const { auth } = authentication();
  // The public host need not equal the internal listener address behind a proxy.
  const origin = "http://localhost:3000";
  const app = createApp(service, "dist/web", 3000, origin, {}, auth);
  const live = createLiveServer();
  const server = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: WebSocket[] = [];
  const canvas = await service.create(context, { title: "Live" });
  const other = await service.create(context, { title: "Other" });
  async function issue() {
    const response = await app.request(`${origin}/api/canvases/${canvas.id}/live-ticket`, {
      method: "POST", headers: { host: "localhost:3000", origin, authorization: "Bearer alice" },
    });
    assert.equal(response.status, 201);
    return (await response.json() as { ticket: string }).ticket;
  }
  function socket(id: string, ticket?: string, requestOrigin = origin) {
    const client = new WebSocket(`${base}/api/canvases/${id}/live${ticket ? `?ticket=${ticket}` : ""}`, {
      origin: requestOrigin, headers: { host: "localhost:3000" },
    });
    client.on("error", () => {});
    clients.push(client);
    return client;
  }
  async function rejected(id: string, ticket?: string, requestOrigin = origin) {
    const client = socket(id, ticket, requestOrigin);
    const [, response] = await once(client, "unexpected-response");
    response.resume();
    client.terminate();
    return response.statusCode;
  }
  try {
    assert.equal(await rejected(canvas.id), 401);
    const ticket = await issue();
    const client = socket(canvas.id, ticket);
    const [snapshot] = await once(client, "message");
    assert.equal(JSON.parse(snapshot.toString()).type, "snapshot");
    assert.equal(await rejected(canvas.id, ticket), 401);
    assert.equal(await rejected(other.id, await issue()), 401);
    assert.equal(await rejected(canvas.id, await issue(), "https://evil.example"), 403);
    client.close();
    await once(client, "close");
    const reconnect = socket(canvas.id, await issue());
    const [fresh] = await once(reconnect, "message");
    assert.equal(JSON.parse(fresh.toString()).canvas.id, canvas.id);
  } finally {
    for (const client of clients) client.terminate();
    for (const socket of live.sockets.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await app.closeMcp();
    await repository.close();
  }
});
