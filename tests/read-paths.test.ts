import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { Client } from "pg";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket } from "ws";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { developmentContext as owner } from "../src/server/auth/context.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import type { ServerMessage } from "../src/shared/live.js";
import { createTestRepository } from "./postgres.js";

const image = { id: "image", type: "image", fileId: "asset", version: 1, versionNonce: 1, isDeleted: false };
const asset = { id: "asset", mimeType: "image/png" as const, dataURL: `data:image/png;base64,${Buffer.alloc(128 * 1024, 171).toString("base64")}`, created: 1 };
const status = (expected: number) => (error: unknown) => error instanceof ServiceError && error.status === expected;

function queriesDuring(t: TestContext) {
  const queries: string[] = [];
  const query = Client.prototype.query;
  t.mock.method(Client.prototype, "query", function(this: Client, ...args: unknown[]) {
    const input = args[0];
    if (typeof input === "string") queries.push(input);
    else if (input && typeof input === "object" && "text" in input) queries.push(String(input.text));
    return Reflect.apply(query, this, args);
  });
  return queries;
}

test("metadata authorization, selections, subscriptions and comments never load asset bytes", async t => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Lightweight reads" });
    await service.mutate(owner, canvas.id, { elements: [image], files: { asset } });
    const full = t.mock.method(repository, "get", async () => { throw new Error("unexpected full canvas read"); });
    const queries = queriesDuring(t);
    const metadata = await service.getMetadata(owner, canvas.id);
    assert.equal("scene" in metadata, false);
    assert.equal(queries.length, 1);
    assert(!/\belements\b|\bshared_settings\b/i.test(queries[0]!));
    const thin = await repository.getScene(canvas.id);
    assert(thin);
    assert.equal("files" in thin.scene, false);
    const stops = await Promise.all([
      service.subscribe(owner, canvas.id, () => {}),
      service.subscribeMetadata(owner, canvas.id, () => {}),
      service.subscribeDeletion(owner, canvas.id, () => {}),
      service.comments.subscribe(owner, canvas.id, () => {}),
    ]);
    const editor = await service.connectEditor(owner, canvas.id);
    await editor.setSelection([image.id]);
    assert.deepEqual((await service.getSelectedElements(owner, canvas.id)).editors[0]!.elementIds, [image.id]);
    const note = { id: randomUUID(), text: "Pinned", anchor: { type: "canvas", x: 0, y: 0 } };
    await service.comments.create(owner, canvas.id, note);
    await service.comments.get(owner, canvas.id);
    await service.comments.edit(owner, canvas.id, note.id, { text: "Edited", expectedText: note.text });
    await service.comments.resolve(owner, canvas.id, note.id);
    const attached = { id: randomUUID(), text: "Image note", anchor: { type: "element", elementId: image.id, u: 0, v: 0, x: 0, y: 0 } };
    await service.comments.create(owner, canvas.id, attached);
    await assert.rejects(service.comments.create(owner, canvas.id, {
      ...attached, id: randomUUID(), anchor: { ...attached.anchor, elementId: "missing" },
    }), status(409));
    await service.rename(owner, canvas.id, { title: "Renamed", expectedTitle: canvas.title });
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    assert.equal(full.mock.callCount(), 0);
    assert(!queries.some(query => /\bFROM\s+assets\b/i.test(query)), "lightweight operations must never query asset storage");
    for (const stop of stops) { stop(); stop(); }
    editor.close();
    const current = await service.getMetadata(owner, canvas.id);
    await service.delete(owner, canvas.id, { confirmTitle: current.title, expectedRevision: current.revision });
    assert.equal(full.mock.callCount(), 0);
  } finally { await repository.close(); }
});

test("lightweight reads preserve private/org boundaries and selection access is rechecked after unsharing", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Access checks" });
    const member = { ...owner, userId: "member" };
    const outsider = { ...owner, organizationId: "other-org" };
    for (const context of [member, outsider]) {
      await assert.rejects(service.getMetadata(context, canvas.id), status(404));
      await assert.rejects(service.connectEditor(context, canvas.id), status(404));
      await assert.rejects(service.comments.get(context, canvas.id), status(404));
      await assert.rejects(service.getSelectedElements(context, canvas.id), status(404));
    }
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    const editor = await service.connectEditor(member, canvas.id);
    await editor.setSelection([]);
    await assert.rejects(service.getMetadata(outsider, canvas.id), status(404));
    await service.setVisibility(owner, canvas.id, { visibility: "private", expectedVisibility: "organization" });
    await assert.rejects(editor.setSelection([image.id]), status(404));
    editor.close();
  } finally { await repository.close(); }
});

test("a WebSocket join reads one full snapshot and subsequent selection messages load metadata only", { timeout: 15_000 }, async t => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000);
  const live = createLiveServer();
  const server = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  let socket: WebSocket | undefined;
  try {
    const canvas = await service.create(owner, { title: "One snapshot" });
    await service.mutate(owner, canvas.id, { elements: [image], files: { asset } });
    const full = t.mock.method(repository, "get");
    const metadata = t.mock.method(repository, "getMetadata");
    const scene = t.mock.method(repository, "getScene");
    const comments = t.mock.method(repository, "getComments");
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    socket = new WebSocket(`ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/canvases/${canvas.id}/live`, { origin: "http://localhost:3000" });
    socket.on("error", () => {});
    const [raw] = await once(socket, "message");
    const snapshot = JSON.parse(raw.toString()) as ServerMessage;
    assert(snapshot.type === "snapshot");
    assert.deepEqual(snapshot.canvas.scene.files, { asset });
    assert.equal(full.mock.callCount(), 1);
    assert.equal(metadata.mock.callCount(), 1, "pre-upgrade access check uses metadata");
    assert.equal(scene.mock.callCount(), 0);
    assert.equal(comments.mock.callCount(), 1);
    const response = once(socket, "message");
    socket.send(JSON.stringify({ type: "selection", elementIds: [image.id] }));
    // Invalid text is queued after selection, giving us a deterministic barrier
    // without adding a scene mutation (which would legitimately load assets).
    socket.send("{");
    const [reply] = await response;
    const error = JSON.parse(reply.toString()) as ServerMessage;
    assert(error.type === "error" && error.status === 400);
    assert.equal(full.mock.callCount(), 1);
    assert.equal(metadata.mock.callCount(), 2);
    assert.deepEqual((await service.getSelectedElements(owner, canvas.id)).editors[0]!.elementIds, [image.id]);
  } finally {
    socket?.terminate();
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await app.closeMcp();
    await repository.close();
  }
});

test("queued live joins reauthorize after sharing changes without leaving subscriptions or presence", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Queued join" });
    const member = { ...owner, userId: "member" };
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    await service.getMetadata(member, canvas.id);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const blocked = service.exclusive(canvas.id, () => gate);
    const unshare = service.setVisibility(owner, canvas.id, { visibility: "private", expectedVisibility: "organization" });
    let callbacks = 0;
    const listener = () => { callbacks++; };
    const denied = assert.rejects(service.openLiveSession(member, canvas.id, {
      snapshot: listener, update: listener, comments: listener, metadata: listener, deleted: listener,
    }), status(404));
    release();
    await Promise.all([blocked, unshare, denied]);
    await service.mutate(owner, canvas.id, { elements: [image], files: { asset } });
    assert.equal(callbacks, 0);
    assert.deepEqual((await service.getSelectedElements(owner, canvas.id)).editors, []);
  } finally { await repository.close(); }
});

for (const failure of ["aborted", "snapshot-error", "abort-after-snapshot"] as const) {
  test(`failed live initialization cleans every subscription and editor (${failure})`, async t => {
    const repository = await createTestRepository();
    try {
      const service = new CanvasService(repository);
      const canvas = await service.create(owner, { title: "Cleanup" });
      const controller = new AbortController();
      if (failure === "aborted") {
        const get = repository.getComments.bind(repository);
        t.mock.method(repository, "getComments", async (id: string) => {
          const state = await get(id);
          controller.abort();
          return state;
        });
      }
      let callbacks = 0;
      const listener = () => { callbacks++; };
      await assert.rejects(service.openLiveSession(owner, canvas.id, {
        snapshot: () => {
          if (failure === "abort-after-snapshot") controller.abort();
          else throw new Error("snapshot failed");
        },
        update: listener, comments: listener, metadata: listener, deleted: listener,
      }, controller.signal));
      await service.mutate(owner, canvas.id, { elements: [image], files: { asset } });
      await service.comments.create(owner, canvas.id, { id: randomUUID(), text: "No leaked listener", anchor: { type: "canvas", x: 0, y: 0 } });
      await service.rename(owner, canvas.id, { title: "Renamed", expectedTitle: canvas.title });
      assert.equal(callbacks, 0);
      assert.deepEqual((await service.getSelectedElements(owner, canvas.id)).editors, []);
    } finally { await repository.close(); }
  });
}
