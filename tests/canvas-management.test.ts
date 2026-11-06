import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";

const owner = { userId: "owner", organizationId: "org-a" };
const member = { userId: "member", organizationId: "org-a" };
const otherOrg = { userId: "owner", organizationId: "org-b" };
const status = (expected: number) => (error: unknown) => error instanceof ServiceError && error.status === expected;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";

test("rename is creator-only, durable and idempotent, retaining scenes, images, comments and visibility", () => {
  const directory = mkdtempSync(join(tmpdir(), "excalibur-management-"));
  const filename = join(directory, "test.sqlite");
  let repository = new SqliteCanvasRepository(filename);
  try {
    let service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "Original" });
    assert.throws(() => service.rename(member, canvas.id, { title: "Other", expectedTitle: canvas.title }), status(404));
    service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    service.mutate(owner, canvas.id, { elements: [{ id: "image", type: "image", fileId: "asset", version: 1, versionNonce: 1, isDeleted: false }],
      files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 1 } } });
    const comments = service.comments.create(owner, canvas.id, { id: randomUUID(), text: "Keep me", anchor: { type: "canvas", x: 0, y: 0 } });
    const before = service.get(owner, canvas.id);
    const changes: string[] = [];
    const unsubscribe = service.subscribeMetadata(owner, canvas.id, metadata => changes.push(metadata.title));
    assert.throws(() => service.rename(member, canvas.id, { title: "Other", expectedTitle: canvas.title }), status(403));
    assert.throws(() => service.rename(otherOrg, canvas.id, { title: "Other", expectedTitle: canvas.title }), status(404));
    for (const title of ["", "  ", "x".repeat(201)]) assert.throws(() => service.rename(owner, canvas.id, { title, expectedTitle: canvas.title }));
    assert.throws(() => service.rename(owner, canvas.id, { title: "Other", expectedTitle: "Stale" }), status(409));
    const renamed = service.rename(owner, canvas.id, { title: "  Renamed  ", expectedTitle: canvas.title });
    assert.equal(renamed.title, "Renamed");
    assert.equal(renamed.revision, before.revision + 1);
    assert.equal(renamed.visibility, "organization");
    assert.deepEqual(service.get(member, canvas.id).scene, before.scene);
    assert.deepEqual(service.comments.get(member, canvas.id), comments);
    assert.deepEqual(service.rename(owner, canvas.id, { title: "Renamed", expectedTitle: "Original" }), renamed);
    assert.deepEqual(changes, ["Renamed"]);
    unsubscribe();
    unsubscribe();
    repository.close();
    repository = new SqliteCanvasRepository(filename);
    service = new CanvasService(repository);
    assert.equal(service.get(member, canvas.id).title, "Renamed");
    assert.deepEqual(service.get(member, canvas.id).scene, before.scene);
    assert.deepEqual(service.comments.get(member, canvas.id), comments);
  } finally { repository.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("delete checks ownership, exact title and revision, cascades data atomically and clears subscriptions", () => {
  const directory = mkdtempSync(join(tmpdir(), "excalibur-deletion-"));
  const filename = join(directory, "test.sqlite");
  const repository = new SqliteCanvasRepository(filename);
  const inspect = new DatabaseSync(filename);
  try {
    const service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "Delete this" });
    service.mutate(owner, canvas.id, { elements: [{ id: "image", type: "image", fileId: "asset", version: 1, versionNonce: 1, isDeleted: false }],
      files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 1 } } });
    service.comments.create(owner, canvas.id, { id: randomUUID(), text: "Delete me too", anchor: { type: "canvas", x: 0, y: 0 } });
    const payload = { confirmTitle: canvas.title, expectedRevision: 1 };
    assert.throws(() => service.delete(member, canvas.id, payload), status(404));
    service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    payload.expectedRevision = 2;
    assert.throws(() => service.delete(member, canvas.id, payload), status(403));
    assert.throws(() => service.delete(otherOrg, canvas.id, payload), status(404));
    assert.throws(() => service.delete(owner, canvas.id, { ...payload, confirmTitle: "Wrong" }), status(409));
    assert.throws(() => service.delete(owner, canvas.id, { ...payload, expectedRevision: 0 }), status(409));
    assert.throws(() => service.delete(owner, canvas.id, { ...payload, confirm: true }));
    const editor = service.connectEditor(owner, canvas.id);
    editor.setSelection(["image"]);
    let notifications = 0;
    const unsubscribe = service.subscribeDeletion(owner, canvas.id, () => { notifications++; });
    let oldSubscriptions = 0;
    service.subscribe(owner, canvas.id, () => { oldSubscriptions++; });
    service.subscribeMetadata(owner, canvas.id, () => { oldSubscriptions++; });
    service.comments.subscribe(owner, canvas.id, () => { oldSubscriptions++; });
    // A failure in a cascaded child deletion must roll the parent and assets back.
    inspect.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    assert.throws(() => service.delete(owner, canvas.id, payload));
    assert.equal(notifications, 0);
    assert(service.get(member, canvas.id).scene.files.asset);
    assert.equal(service.comments.get(member, canvas.id).comments.length, 1);
    inspect.exec("DROP TRIGGER fail_delete");
    assert.deepEqual(service.delete(owner, canvas.id, payload), { canvasId: canvas.id, deleted: true });
    assert.equal(notifications, 1);
    for (const table of ["canvases", "assets", "comments"]) assert.equal(inspect.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count, 0);
    assert.equal(repository.get(canvas.id), undefined);
    assert.throws(() => service.get(owner, canvas.id), status(404));
    assert.throws(() => service.delete(owner, canvas.id, payload), status(404));
    // Reusing this ID through the test adapter cannot resurrect old listeners.
    repository.create(canvas);
    service.mutate(owner, canvas.id, { elements: [{ id: "box", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false }] });
    service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    service.comments.create(owner, canvas.id, { id: randomUUID(), text: "New note", anchor: { type: "canvas", x: 1, y: 1 } });
    assert.equal(service.getSelectedElements(owner, canvas.id).editors.length, 0);
    assert.equal(oldSubscriptions, 0);
    editor.close();
    unsubscribe();
    unsubscribe();
  } finally { inspect.close(); repository.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("failed rename and stale delete persistence never publish or remove data", t => {
  const repository = new SqliteCanvasRepository(":memory:");
  try {
    const service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "Keep" });
    let published = 0;
    service.subscribeMetadata(owner, canvas.id, () => { published++; });
    service.subscribeDeletion(owner, canvas.id, () => { published++; });
    t.mock.method(repository, "rename", () => undefined);
    t.mock.method(repository, "delete", () => false);
    assert.throws(() => service.rename(owner, canvas.id, { title: "New", expectedTitle: "Keep" }), status(409));
    assert.throws(() => service.delete(owner, canvas.id, { confirmTitle: "Keep", expectedRevision: 0 }), status(409));
    assert.equal(published, 0);
    assert.equal(service.get(owner, canvas.id).title, "Keep");
    assert.equal(service.get(owner, canvas.id).revision, 0);
  } finally { repository.close(); }
});
