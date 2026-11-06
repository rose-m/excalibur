import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebSocket } from "ws";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { developmentContext as context } from "../src/server/auth/context.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import { createTestRepository } from "./postgres.js";
import { clientMessageSchema } from "../src/shared/live.js";

const element = (id: string, version = 1, isDeleted = false) => ({ id, type: "rectangle", version, versionNonce: 1, isDeleted });

test("editor selections are authorized, isolated, ephemeral, and resolve only current committed elements", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  try {
    const canvas = await service.create(context, { title: "Selection" });
    const other = await service.create(context, { title: "Other canvas" });
    await service.mutate(context, canvas.id, { elements: [element("a"), element("b")] });
    await service.mutate(context, other.id, { elements: [element("foreign")] });
    const committed = await service.get(context, canvas.id);
    const a = await service.connectEditor(context, canvas.id), b = await service.connectEditor(context, canvas.id);
    await a.setSelection(["a", "a", "missing", "foreign"]);
    await b.setSelection(["b"]);
    const selected = await service.getSelectedElements(context, canvas.id);
    assert.deepEqual(selected.editors.map(editor => editor.elementIds), [["a"], ["b"]]);
    assert.notEqual(selected.editors[0]!.editorId, selected.editors[1]!.editorId);
    assert.deepEqual((await service.getSelectedElements(context, other.id)).editors, []);
    assert.deepEqual(await service.get(context, canvas.id), committed, "selection must not write metadata, scene or revision");
    await assert.rejects(() => a.setSelection(["x".repeat(201)]));
    assert.deepEqual(await service.getSelectedElements(context, canvas.id), selected, "invalid selection must leave prior state intact");
    await service.mutate(context, canvas.id, { elements: [{ ...element("a", 2), width: 123 }, element("b", 2, true)] });
    const latest = await service.getSelectedElements(context, canvas.id);
    assert.equal(latest.editors[0]!.elements[0]!.width, 123);
    assert.deepEqual(latest.editors[1]!.elementIds, []);
    const denied = (error: unknown) => error instanceof ServiceError && error.status === 404;
    for (const identity of [{ ...context, userId: "another user" }, { ...context, organizationId: "another organization" }]) {
      await assert.rejects(async () => await service.getSelectedElements(identity, canvas.id), denied);
      await assert.rejects(async () => await service.connectEditor(identity, canvas.id), denied);
    }
    a.close();
    a.close();
    await a.setSelection(["a"]);
    assert.equal((await service.getSelectedElements(context, canvas.id)).editors.length, 1);
    b.close();
    const replacement = await service.connectEditor(context, canvas.id);
    a.close();
    assert.equal((await service.getSelectedElements(context, canvas.id)).editors.length, 1);
    assert.deepEqual((await service.getSelectedElements(context, canvas.id)).editors[0]!.elementIds, []);
    const replacementId = (await service.getSelectedElements(context, canvas.id)).editors[0]!.editorId;
    assert(!selected.editors.some(editor => editor.editorId === replacementId));
    assert.deepEqual((await new CanvasService(repository).getSelectedElements(context, canvas.id)).editors, [], "presence must not survive a service restart");
    replacement.close();
    assert.deepEqual((await service.getSelectedElements(context, canvas.id)).editors, []);
  } finally { await repository.close(); }
});

test("selection messages reject identity spoofing and bound payload sizes", () => {
  assert(clientMessageSchema.safeParse({ type: "selection", elementIds: [] }).success);
  for (const message of [
    { type: "selection", elementIds: [1] },
    { type: "selection", elementIds: [""] },
    { type: "selection", elementIds: ["x".repeat(201)] },
    { type: "selection", elementIds: Array(20_001).fill("a") },
    { type: "selection", elementIds: ["a"], editorId: "spoofed" },
    { type: "selection", elementIds: ["a"], canvasId: "another" },
  ]) assert(!clientMessageSchema.safeParse(message).success);
});

test("MCP reads live per-tab selections, with no scene broadcasts or revisions and cleanup on disconnect", { timeout: 15_000 }, async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000);
  const live = createLiveServer();
  const http = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  let client = new Client({ name: "selection-test", version: "1" });
  async function connect(id: string) {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/api/canvases/${id}/live`, { origin: "http://localhost:3000" });
    sockets.push(socket);
    const snapshot = once(socket, "message");
    await snapshot;
    return socket;
  }
  async function select(socket: WebSocket, elementIds: string[]) {
    // A following no-op mutation is a FIFO barrier; selection itself has no
    // scene acknowledgment, revision, or peer broadcast.
    const ack = once(socket, "message");
    socket.send(JSON.stringify({ type: "selection", elementIds }));
    socket.send(JSON.stringify({ type: "mutate", requestId: randomUUID(), mutation: { elements: [] } }));
    const [data] = await ack;
    assert.equal(JSON.parse(data.toString()).type, "ack");
  }
  async function read(canvasId: string) {
    const result = await client.callTool({ name: "get_selected_elements", arguments: { canvasId } });
    assert(!result.isError, JSON.stringify(result));
    return result.structuredContent as { revision: number; editors: { editorId: string; elementIds: string[]; elements: { id: string; version: number }[] }[] };
  }
  try {
    const canvas = await service.create(context, { title: "Connected" });
    const other = await service.create(context, { title: "Isolated" });
    await service.mutate(context, canvas.id, { elements: [element("a"), element("b")] });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.deepEqual((await read(canvas.id)).editors, []);
    const a = await connect(canvas.id), b = await connect(canvas.id), isolated = await connect(other.id);
    const peerMessages: unknown[] = [];
    b.on("message", data => peerMessages.push(JSON.parse(data.toString())));
    await select(a, ["a"]);
    assert.deepEqual(peerMessages, []);
    const first = await read(`http://127.0.0.1:3000/canvases/${canvas.id}`);
    assert.deepEqual(first.editors.map(editor => editor.elementIds), [["a"], []]);
    assert.equal(first.revision, 1);
    await select(b, ["b", "b"]);
    assert.deepEqual((await read(canvas.id)).editors.map(editor => editor.elementIds), [["a"], ["b"]]);
    assert.equal((await service.get(context, canvas.id)).revision, 1);
    assert.deepEqual((await read(other.id)).editors.map(editor => editor.elementIds), [[]]);
    await select(a, []);
    assert.deepEqual((await read(canvas.id)).editors[0]!.elementIds, []);
    await client.close();
    client = new Client({ name: "reconnected-mcp", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.equal((await read(canvas.id)).editors[0]!.editorId, first.editors[0]!.editorId, "MCP reconnect must not replace browser presence");
    const closed = once(b, "close"); await b.close(); await closed;
    assert.equal((await read(canvas.id)).editors.length, 1);
    const replacement = await connect(canvas.id);
    assert.deepEqual((await read(canvas.id)).editors.map(editor => editor.elementIds), [[], []]);
    assert.notEqual((await read(canvas.id)).editors[1]!.editorId, first.editors[1]!.editorId);
    for (const socket of [a, isolated, replacement]) { const closed = once(socket, "close"); socket.close(); await closed; }
    assert.deepEqual((await read(canvas.id)).editors, []);
    assert.equal((await service.get(context, canvas.id)).revision, 1);
  } finally {
    await client.close();
    for (const socket of sockets) socket.terminate();
    await app.closeMcp();
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await repository.close();
  }
});
