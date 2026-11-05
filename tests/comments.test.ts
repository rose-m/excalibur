import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket } from "ws";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { developmentContext as owner } from "../src/server/auth/context.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import type { Scene } from "../src/shared/canvas.js";
import type { CommentState } from "../src/shared/comments.js";
import { anchorAt, commentPosition, commentTarget } from "../src/web/comment-geometry.js";

const shape = (id = "shape"): Scene["elements"][number] => ({ id, type: "rectangle", x: 100, y: 100, width: 200, height: 100, angle: 0, version: 1, versionNonce: 1, isDeleted: false });
const note = (text = "Check this") => ({ id: randomUUID(), text, anchor: { type: "canvas" as const, x: 10, y: 20 } });
const status = (expected: number) => (error: unknown) => error instanceof ServiceError && error.status === expected;

test("comments enforce canvas access, validate targets, and add/resolve without changing scene revisions", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  try {
    const canvas = service.create(owner, { title: "Notes" });
    const other = service.create(owner, { title: "Other" });
    service.mutate(owner, canvas.id, { elements: [shape()] });
    const before = service.get(owner, canvas.id);
    const events: CommentState[] = [];
    const unsubscribe = service.comments.subscribe(owner, canvas.id, state => events.push(state));
    const a = note("  First note\nwith a second line  ");
    const b = { ...note("Attached"), anchor: anchorAt({ x: 150, y: 120 }, shape()) };
    const first = service.comments.create(owner, canvas.id, a);
    assert.equal(first.comments[0]!.text, "First note\nwith a second line");
    assert.equal(first.revision, 1);
    assert(!Number.isNaN(Date.parse(first.comments[0]!.createdAt)));
    service.comments.create(owner, canvas.id, a);
    assert.equal(events.length, 1, "retrying the same ID/content is idempotent");
    service.comments.create(owner, canvas.id, b);
    assert.equal(service.comments.get(owner, canvas.id).comments.length, 2);
    assert.deepEqual(service.get(owner, canvas.id), before);
    assert.deepEqual(service.comments.get(owner, other.id), { revision: 0, comments: [] });
    assert.throws(() => service.comments.create(owner, canvas.id, { ...a, text: "Different" }), status(409));
    assert.throws(() => service.comments.create(owner, canvas.id, { ...note(), anchor: { ...b.anchor, elementId: "missing" } }), status(409));
    for (const bad of [{ ...note(), text: " " }, { ...note(), text: "x".repeat(4001) }, { ...note(), author: "spoofed" }, { ...note(), anchor: { type: "canvas", x: Infinity, y: 0 } }]) {
      assert.throws(() => service.comments.create(owner, canvas.id, bad));
    }
    for (const context of [{ ...owner, userId: "someone else" }, { ...owner, organizationId: "other org" }]) {
      assert.throws(() => service.comments.get(context, canvas.id), status(404));
      assert.throws(() => service.comments.create(context, canvas.id, note()), status(404));
      assert.throws(() => service.comments.resolve(context, canvas.id, a.id), status(404));
      assert.throws(() => service.comments.subscribe(context, canvas.id, () => {}), status(404));
    }
    service.comments.resolve(owner, other.id, a.id);
    assert.equal(service.comments.get(owner, canvas.id).comments.length, 2, "a different canvas cannot resolve this note");
    const resolved = service.comments.resolve(owner, canvas.id, a.id);
    assert.equal(resolved.revision, 3);
    assert.deepEqual(resolved.comments.map(comment => comment.id), [b.id]);
    service.comments.resolve(owner, canvas.id, a.id);
    assert.equal(events.length, 3, "resolving twice does not publish or advance revision");
    assert.deepEqual(service.get(owner, canvas.id), before);
    unsubscribe(); unsubscribe();
    service.comments.create(owner, canvas.id, note());
    assert.equal(events.length, 3);
  } finally { repository.close(); }
});

test("comment edits preserve identity and anchors, reject stale edits and never resurrect resolved notes", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  try {
    const canvas = service.create(owner, { title: "Editable notes" });
    const other = service.create(owner, { title: "Other" });
    const original = note("Original");
    const created = service.comments.create(owner, canvas.id, original).comments[0]!;
    let published = 0;
    service.comments.subscribe(owner, canvas.id, () => { published++; });
    const input = { text: "  Edited\ntext  ", expectedText: "Original" };
    const result = service.comments.edit(owner, canvas.id, original.id, input);
    assert.equal(result.revision, 2);
    assert.deepEqual(result.comments[0], { ...created, text: "Edited\ntext" });
    assert.equal(published, 1);
    assert.deepEqual(service.comments.edit(owner, canvas.id, original.id, input), result, "uncertain saves can be retried");
    assert.equal(published, 1);
    assert.throws(() => service.comments.edit(owner, canvas.id, original.id, { text: "Stale edit", expectedText: "Original" }), status(409));
    assert.throws(() => service.comments.edit(owner, other.id, original.id, input), status(404));
    assert.throws(() => service.comments.edit({ ...owner, userId: "other" }, canvas.id, original.id, input), status(404));
    for (const bad of [{ ...input, text: " " }, { ...input, text: "x".repeat(4001) }, { text: "No baseline" }, { ...input, anchor: original.anchor }]) {
      assert.throws(() => service.comments.edit(owner, canvas.id, original.id, bad));
    }
    assert.equal(service.comments.get(owner, canvas.id).revision, 2);
    service.comments.resolve(owner, canvas.id, original.id);
    assert.throws(() => service.comments.edit(owner, canvas.id, original.id, input), status(404));
    assert.deepEqual(service.comments.get(owner, canvas.id), { revision: 3, comments: [] });
    assert.equal(service.get(owner, canvas.id).revision, 0);
  } finally { repository.close(); }
});

test("comment migration preserves existing drawings and comments survive restarts; failed transactions never publish", () => {
  const directory = mkdtempSync(join(tmpdir(), "excalibur-comments-"));
  const oldMigrations = join(directory, "old-migrations");
  mkdirSync(oldMigrations);
  copyFileSync("migrations/001_initial.sql", join(oldMigrations, "001_initial.sql"));
  const filename = join(directory, "canvas.sqlite");
  let repository = new SqliteCanvasRepository(filename, oldMigrations);
  let raw: DatabaseSync | undefined;
  try {
    let service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "Existing" });
    service.mutate(owner, canvas.id, { elements: [shape()] });
    const original = service.get(owner, canvas.id);
    repository.close();
    repository = new SqliteCanvasRepository(filename);
    service = new CanvasService(repository);
    assert.deepEqual(service.get(owner, canvas.id), original);
    const a = note();
    service.comments.create(owner, canvas.id, a);
    repository.close();
    repository = new SqliteCanvasRepository(filename);
    service = new CanvasService(repository);
    assert.equal(service.comments.get(owner, canvas.id).comments[0]!.id, a.id);
    let published = 0;
    service.comments.subscribe(owner, canvas.id, () => { published++; });
    raw = new DatabaseSync(filename);
    raw.exec("CREATE TRIGGER fail_comment_revision BEFORE UPDATE OF comments_revision ON canvases BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    assert.throws(() => service.comments.create(owner, canvas.id, note("Must roll back")));
    assert.throws(() => service.comments.resolve(owner, canvas.id, a.id));
    assert.throws(() => service.comments.edit(owner, canvas.id, a.id, { text: "Must roll back", expectedText: a.text }));
    assert.equal(published, 0);
    assert.equal(service.comments.get(owner, canvas.id).revision, 1);
    assert.equal(service.comments.get(owner, canvas.id).comments.length, 1);
    assert.deepEqual(service.get(owner, canvas.id), original);
    raw.exec("DROP TRIGGER fail_comment_revision");
    service.comments.edit(owner, canvas.id, a.id, { text: "Persisted edit", expectedText: a.text });
    repository.close();
    repository = new SqliteCanvasRepository(filename);
    service = new CanvasService(repository);
    assert.equal(service.comments.get(owner, canvas.id).comments[0]!.text, "Persisted edit");
    service.comments.resolve(owner, canvas.id, a.id);
    assert.equal(service.comments.get(owner, canvas.id).comments.length, 0);
    repository.close();
    repository = new SqliteCanvasRepository(filename);
    assert.deepEqual(new CanvasService(repository).comments.get(owner, canvas.id), { revision: 3, comments: [] });
  } finally { raw?.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("comment limits are enforced and resolving a note releases capacity", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  try {
    const canvas = service.create(owner, { title: "Bounded notes" });
    const first = note();
    service.comments.create(owner, canvas.id, first);
    for (let i = 1; i < 500; i++) service.comments.create(owner, canvas.id, note());
    assert.throws(() => service.comments.create(owner, canvas.id, note()), status(413));
    assert.equal(service.comments.get(owner, canvas.id).revision, 500);
    assert.equal(service.comments.create(owner, canvas.id, first).comments.length, 500, "idempotent retries still work at the limit");
    service.comments.resolve(owner, canvas.id, first.id);
    assert.equal(service.comments.create(owner, canvas.id, note()).comments.length, 500);
    assert.equal(service.get(owner, canvas.id).revision, 0);
  } finally { repository.close(); }
});

test("comment pins follow movement, resize, rotation, negative linear points and retained tombstones", () => {
  const original = shape();
  const anchor = anchorAt({ x: 150, y: 125 }, original);
  assert.deepEqual(commentPosition(anchor, new Map([[original.id, { ...original, x: 200, y: 300, width: 400, height: 200 }]])), { x: 300, y: 350 });
  const rotated = { ...original, angle: Math.PI / 2 };
  const point = commentPosition(anchor, new Map([[original.id, rotated]]));
  assert(Math.abs(point.x - 225) < 0.001 && Math.abs(point.y - 100) < 0.001);
  assert.deepEqual(commentPosition(anchorAt(point, rotated), new Map([[original.id, rotated]])), point);
  assert.deepEqual(commentPosition(anchor, new Map()), { x: 150, y: 125 });
  const deleted = { ...original, x: 300, isDeleted: true };
  assert.deepEqual(commentPosition(anchor, new Map([[original.id, deleted]])), { x: 350, y: 125 });
  assert.deepEqual(commentPosition(anchorAt({ x: 20, y: 30 }), new Map()), { x: 20, y: 30 });
  const line = { ...shape("line"), type: "line", points: [[0, 0], [-100, 100]] };
  assert.equal(commentTarget({ x: 50, y: 150 }, [line], 1)?.id, "line");
  assert.equal(commentTarget({ x: 100, y: 200 }, [line], 1), undefined, "a line bounding box is not the line");
  const label = { ...shape("label"), type: "text", containerId: original.id };
  assert.equal(commentTarget({ x: 150, y: 120 }, [original, label], 1)?.id, original.id);
  assert.equal(commentTarget({ x: 101, y: 101 }, [{ ...original, type: "ellipse" }], 1), undefined);
  assert.equal(commentTarget({ x: 200, y: 150 }, [{ ...original, type: "ellipse" }], 1)?.id, original.id);
  assert.equal(commentTarget({ x: 500, y: 500 }, [original], 1), undefined);
});

test("HTTP comments broadcast to live tabs and reconnect snapshots without affecting drawing revisions", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000);
  const live = createLiveServer();
  const server = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const sockets: WebSocket[] = [];
  async function connect(id: string) {
    const socket = new WebSocket(`${base.replace("http:", "ws:")}/api/canvases/${id}/live`, { origin: "http://localhost:3000" });
    sockets.push(socket);
    const [data] = await once(socket, "message");
    return { socket, snapshot: JSON.parse(data.toString()) };
  }
  try {
    const canvas = service.create(owner, { title: "Live notes" });
    const endpoint = `${base}/api/canvases/${canvas.id}/comments`;
    const a = await connect(canvas.id), b = await connect(canvas.id);
    assert.deepEqual(a.snapshot.comments, { revision: 0, comments: [] });
    const noteA = note("Visible to both tabs");
    const receivedA = once(a.socket, "message"), receivedB = once(b.socket, "message");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(noteA) });
    assert.equal(response.status, 201);
    const state = await response.json();
    for (const promise of [receivedA, receivedB]) {
      const [data] = await promise;
      assert.deepEqual(JSON.parse(data.toString()), { type: "comments", state });
    }
    assert.equal(service.get(owner, canvas.id).revision, 0);
    const reconnected = await connect(canvas.id);
    assert.deepEqual(reconnected.snapshot.comments, state);
    assert.deepEqual(await (await fetch(endpoint)).json(), state);
    const editedA = once(a.socket, "message"), editedB = once(b.socket, "message");
    const editResponse = await fetch(`${endpoint}/${noteA.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Edited from the UI", expectedText: noteA.text }) });
    assert.equal(editResponse.status, 200);
    const editedState = await editResponse.json() as CommentState;
    assert.equal(editedState.comments[0]!.text, "Edited from the UI");
    assert.equal(editedState.revision, 2);
    for (const event of [editedA, editedB]) {
      const [data] = await event;
      assert.deepEqual(JSON.parse(data.toString()), { type: "comments", state: editedState });
    }
    assert.equal((await fetch(`${endpoint}/${noteA.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Conflicting edit", expectedText: noteA.text }) })).status, 409);
    const removed = once(b.socket, "message");
    const resolved = await fetch(`${endpoint}/${noteA.id}`, { method: "DELETE" });
    assert.equal(resolved.status, 200);
    const [data] = await removed;
    assert.deepEqual(JSON.parse(data.toString()).state, { revision: 3, comments: [] });
    assert.equal(service.get(owner, canvas.id).revision, 0);
    assert.equal((await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(note(" ")) })).status, 400);
    assert.equal((await fetch(`${base}/api/canvases/${randomUUID()}/comments`)).status, 404);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.closeMcp();
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    repository.close();
  }
});
