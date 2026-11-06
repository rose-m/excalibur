import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebSocket } from "ws";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { createTestRepository, reopenTestRepository } from "./postgres.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import type { CanvasMetadata } from "../src/shared/canvas.js";
import type { ServerMessage } from "../src/shared/live.js";

const owner = { userId: "owner", organizationId: "org-a" };
const member = { userId: "member", organizationId: "org-a" };
const outsider = { userId: "owner", organizationId: "org-b" };
const status = (expected: number) => (error: unknown) => error instanceof ServiceError && error.status === expected;

test("sharing is creator-only, durable, idempotent and does not overwrite scenes or bypass org boundaries", async () => {
  let repository = await createTestRepository();
  try {
    let service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Shared canvas" });
    await service.mutate(owner, canvas.id, { elements: [{ id: "shape", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false }] });
    const scene = (await service.get(owner, canvas.id)).scene;
    const share = { visibility: "organization", expectedVisibility: "private" };
    await assert.rejects(async () => await service.setVisibility(member, canvas.id, share), status(404));
    await assert.rejects(async () => await service.setVisibility(outsider, canvas.id, share), status(404));
    const metadata: CanvasMetadata[] = [];
    const unsubscribe = await service.subscribeMetadata(owner, canvas.id, value => metadata.push(value));
    await assert.rejects(async () => await service.setVisibility(owner, canvas.id, { ...share, visibility: "public" }));
    await assert.rejects(async () => await service.setVisibility(owner, canvas.id, { ...share, organizationId: "org-b" }));
    await assert.rejects(async () => await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "organization" }), status(409));
    const shared = await service.setVisibility(owner, canvas.id, share);
    assert.equal(shared.visibility, "organization");
    assert.equal(shared.revision, 2);
    assert.deepEqual((await service.get(member, canvas.id)).scene, scene);
    assert.equal((await service.list(member))[0]?.id, canvas.id);
    await assert.rejects(async () => await service.get(outsider, canvas.id), status(404));
    await assert.rejects(async () => await service.setVisibility(member, canvas.id, { visibility: "private", expectedVisibility: "organization" }), status(403));
    assert.deepEqual(await service.setVisibility(owner, canvas.id, share), shared, "a retry does not advance revision or publish again");
    assert.equal(metadata.length, 1);
    unsubscribe();
    unsubscribe();
    await repository.close();
    repository = await reopenTestRepository(repository);
    service = new CanvasService(repository);
    assert.equal((await service.get(member, canvas.id)).visibility, "organization");
    const privateCanvas = await service.setVisibility(owner, canvas.id, { visibility: "private", expectedVisibility: "organization" });
    assert.equal(privateCanvas.revision, 3);
    assert.deepEqual((await service.get(owner, canvas.id)).scene, scene);
    assert.equal((await service.list(member)).length, 0);
    await assert.rejects(async () => await service.get(member, canvas.id), status(404));
    await repository.close();
    repository = await reopenTestRepository(repository);
    assert.equal((await repository.get(canvas.id))?.visibility, "private");
    assert.equal(metadata.length, 1);
  } finally { await repository.close(); }
});

test("failed visibility persistence never publishes or changes committed access", async t => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Atomic sharing" });
    let published = 0;
    await service.subscribe(owner, canvas.id, () => { published++; });
    await service.subscribeMetadata(owner, canvas.id, () => { published++; });
    t.mock.method(repository, "setVisibility", () => undefined);
    await assert.rejects(async () => await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" }), status(409));
    assert.equal(published, 0);
    assert.equal((await service.get(owner, canvas.id)).revision, 0);
    await assert.rejects(async () => await service.get(member, canvas.id), status(404));
  } finally { await repository.close(); }
});

function nextMessage(socket: WebSocket, type: ServerMessage["type"]): Promise<ServerMessage> {
  return new Promise(resolve => {
    const listener = (data: Buffer) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      if (message.type === type) { socket.off("message", listener); resolve(message); }
    };
    socket.on("message", listener);
  });
}

test("HTTP, MCP and live clients enforce sharing and creator-only canvas management", { timeout: 15_000 }, async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  let app!: ReturnType<typeof createApp>;
  const live = createLiveServer();
  const http = createAdaptorServer({ fetch: (request, env) => app.fetch(request, env), websocket: live.adapter });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const identities = { owner, member, outsider };
  const getContext = (header: string | undefined) => {
    const name = header?.replace("Bearer ", "") as keyof typeof identities;
    const context = identities[name];
    if (!context) throw new ServiceError(401, "Sign in required");
    return context;
  };
  const getPrincipal = async (userId: string) => ({ userId, organizations: [{ id: "org-a", name: "A" }, { id: "org-b", name: "B" }] });
  app = createApp(service, "dist/web", 3000, base, {}, {
    authUrl: "https://auth.example", getPrincipal,
    authenticate: async header => getPrincipal(getContext(header).userId),
  }, { resource: `${base}/mcp`, authorizationServer: "https://auth.example/oauth/2.1", authenticate: async header => getContext(header) });
  const request = (path: string, identity: keyof typeof identities, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", new URL(base).host);
    headers.set("origin", base);
    headers.set("authorization", `Bearer ${identity}`);
    headers.set("x-organization-id", identities[identity].organizationId);
    return app.request(`${base}${path}`, { ...init, headers });
  };
  const clients: Client[] = [];
  const sockets: WebSocket[] = [];
  const connect = async (identity: keyof typeof identities) => {
    const client = new Client({ name: identity, version: "1" });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${identity}` } } }));
    return client;
  };
  const socketFor = async (canvasId: string, identity: keyof typeof identities) => {
    const response = await request(`/api/canvases/${canvasId}/live-ticket`, identity, { method: "POST" });
    assert.equal(response.status, 201);
    const { ticket } = await response.json() as { ticket: string };
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/api/canvases/${canvasId}/live?ticket=${ticket}`, { origin: base });
    sockets.push(socket);
    const snapshot = await nextMessage(socket, "snapshot");
    assert.equal(snapshot.type, "snapshot");
    return socket;
  };
  try {
    const canvas = await service.create(owner, { title: "Team drawing" });
    const path = `/api/canvases/${canvas.id}`;
    assert.equal((await request(`${path}/live-ticket`, "member", { method: "POST" })).status, 404);
    const ownerSocket = await socketFor(canvas.id, "owner");
    const ownerMetadata = nextMessage(ownerSocket, "metadata");
    const shared = await request(`${path}/visibility`, "owner", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "organization", expectedVisibility: "private" }) });
    assert.equal(shared.status, 200);
    assert.equal((await ownerMetadata).type, "metadata");
    assert.equal((await request(path, "member")).status, 200);
    assert.equal((await request(path, "outsider")).status, 404);
    const memberSocket = await socketFor(canvas.id, "member");
    const pendingTicketResponse = await request(`${path}/live-ticket`, "member", { method: "POST" });
    const pendingTicket = (await pendingTicketResponse.json() as { ticket: string }).ticket;
    const ownerClient = await connect("owner");
    const memberClient = await connect("member");
    const outsiderClient = await connect("outsider");
    const tool = (await ownerClient.listTools()).tools.find(item => item.name === "set_canvas_visibility");
    assert.equal(tool?.annotations?.destructiveHint, true);
    for (const [client, identity, expected] of [[memberClient, "member", 403], [outsiderClient, "outsider", 404]] as const) {
      for (const [name, method, input] of [
        ["rename_canvas", "PATCH", { title: "Denied", expectedTitle: canvas.title }],
        ["delete_canvas", "DELETE", { confirmTitle: canvas.title, expectedRevision: 1 }],
      ] as const) {
        const denied = await client.callTool({ name, arguments: { canvasId: canvas.id, ...input } });
        assert.equal((denied.structuredContent as { error: { status: number } }).error.status, expected);
        assert.equal((await request(path, identity, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(input) })).status, expected);
      }
    }
    assert.equal((await memberClient.callTool({ name: "get_canvas", arguments: { canvasId: canvas.id } })).isError, undefined);
    const edited = await memberClient.callTool({ name: "apply_mutations", arguments: { canvasId: canvas.id, expectedRevision: 1, elements: [{ id: "member-edit", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false }] } });
    assert(!edited.isError);
    for (const [client, expected] of [[memberClient, 403], [outsiderClient, 404]] as const) {
      const denied = await client.callTool({ name: "set_canvas_visibility", arguments: { canvasId: canvas.id, visibility: "private", expectedVisibility: "organization" } });
      assert.equal((denied.structuredContent as { error: { status: number } }).error.status, expected);
    }
    assert.equal((await request(`${path}/visibility`, "member", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility: "private", expectedVisibility: "organization" }) })).status, 403);
    const memberMetadata = nextMessage(memberSocket, "metadata");
    const unshared = await ownerClient.callTool({ name: "set_canvas_visibility", arguments: { canvasId: `${base}/canvases/${canvas.id}`, visibility: "private", expectedVisibility: "organization" } });
    assert(!unshared.isError);
    const message = await memberMetadata;
    assert(message.type === "metadata" && message.metadata.visibility === "private");
    assert.equal((await service.get(owner, canvas.id)).revision, 3);
    for (const suffix of ["", "/comments", "/live-ticket"]) {
      assert.equal((await request(`${path}${suffix}`, "member", suffix === "/live-ticket" ? { method: "POST" } : {})).status, 404);
    }
    const staleSocket = new WebSocket(`${base.replace("http:", "ws:")}${path}/live?ticket=${pendingTicket}`, { origin: base });
    sockets.push(staleSocket);
    staleSocket.on("error", () => {});
    const [, rejectedUpgrade] = await once(staleSocket, "unexpected-response");
    rejectedUpgrade.resume();
    staleSocket.terminate();
    assert.equal(rejectedUpgrade.statusCode, 404, "tickets issued before unsharing cannot open a new connection");
    for (const name of ["get_canvas", "get_comments", "get_canvas_screenshot"]) {
      const denied = await memberClient.callTool({ name, arguments: { canvasId: canvas.id } });
      assert.equal((denied.structuredContent as { error: { status: number } }).error.status, 404);
    }
    const update = nextMessage(memberSocket, "update");
    await service.mutate(owner, canvas.id, { elements: [{ id: "owner-edit", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false }] });
    assert.equal((await update).type, "update", "existing live subscriptions are not forcibly revoked in this version");
    const renamedMetadata = nextMessage(ownerSocket, "metadata");
    const renamed = await ownerClient.callTool({ name: "rename_canvas", arguments: { canvasId: `${base}/canvases/${canvas.id}`, title: "Renamed canvas", expectedTitle: canvas.title } });
    assert(!renamed.isError);
    const renamedMessage = await renamedMetadata;
    assert(renamedMessage.type === "metadata" && renamedMessage.metadata.title === "Renamed canvas");
    assert.equal(ownerSocket.readyState, WebSocket.OPEN, "renaming does not reset live editing");
    const renameResponse = await request(path, "owner", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Final name", expectedTitle: "Renamed canvas" }) });
    assert.equal(renameResponse.status, 200);
    const reviewed = await renameResponse.json() as CanvasMetadata;
    assert.equal(reviewed.revision, 6);
    assert.equal((await request(path, "owner", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmTitle: "Final name", expectedRevision: 0 }) })).status, 409);
    const ownerDeleted = nextMessage(ownerSocket, "deleted");
    const memberDeleted = nextMessage(memberSocket, "deleted");
    const ownerClosed = once(ownerSocket, "close");
    const memberClosed = once(memberSocket, "close");
    const deleted = await request(path, "owner", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmTitle: reviewed.title, expectedRevision: reviewed.revision }) });
    assert.equal(deleted.status, 200);
    assert.equal((await ownerDeleted).type, "deleted");
    assert.equal((await memberDeleted).type, "deleted");
    assert.equal((await ownerClosed)[0], 1008);
    assert.equal((await memberClosed)[0], 1008);
    for (const suffix of ["", "/comments", "/live-ticket"]) assert.equal((await request(`${path}${suffix}`, "owner", suffix === "/live-ticket" ? { method: "POST" } : {})).status, 404);
    assert.equal((await service.list(owner)).length, 0);
    const another = await service.create(owner, { title: "MCP deletion" });
    const deleteTool = (await ownerClient.listTools()).tools.find(item => item.name === "delete_canvas");
    assert.equal(deleteTool?.annotations?.destructiveHint, true);
    const deletedByAgent = await ownerClient.callTool({ name: "delete_canvas", arguments: { canvasId: another.id, confirmTitle: another.title, expectedRevision: 0 } });
    assert(!deletedByAgent.isError);
    assert.deepEqual(deletedByAgent.structuredContent, { canvasId: another.id, deleted: true });
    assert.equal(await repository.get(another.id), undefined);
  } finally {
    for (const socket of sockets) socket.terminate();
    for (const socket of live.sockets.clients) socket.terminate();
    for (const client of clients) await client.close();
    await new Promise<void>(resolve => http.close(() => resolve()));
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await app.closeMcp();
    await repository.close();
  }
});
