import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { createTestRepository, reopenTestRepository, testDatabase } from "./postgres.js";

const owner = { userId: "owner", organizationId: "org-a" };
const member = { userId: "member", organizationId: "org-a" };
const otherOrg = { userId: "owner", organizationId: "org-b" };
const status = (expected: number) => (error: unknown) => error instanceof ServiceError && error.status === expected;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";

test("rename is creator-only, durable and idempotent, retaining scenes, images, comments and visibility", async () => {
  let repository = await createTestRepository();
  try {
    let service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Original" });
    await assert.rejects(async () => await service.rename(member, canvas.id, { title: "Other", expectedTitle: canvas.title }), status(404));
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    await service.mutate(owner, canvas.id, { elements: [{ id: "image", type: "image", fileId: "asset", version: 1, versionNonce: 1, isDeleted: false }],
      files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 1 } } });
    const comments = await service.comments.create(owner, canvas.id, { id: randomUUID(), text: "Keep me", anchor: { type: "canvas", x: 0, y: 0 } });
    const before = await service.get(owner, canvas.id);
    const changes: string[] = [];
    const unsubscribe = await service.subscribeMetadata(owner, canvas.id, metadata => changes.push(metadata.title));
    await assert.rejects(async () => await service.rename(member, canvas.id, { title: "Other", expectedTitle: canvas.title }), status(403));
    await assert.rejects(async () => await service.rename(otherOrg, canvas.id, { title: "Other", expectedTitle: canvas.title }), status(404));
    for (const title of ["", "  ", "x".repeat(201)]) await assert.rejects(async () => await service.rename(owner, canvas.id, { title, expectedTitle: canvas.title }));
    await assert.rejects(async () => await service.rename(owner, canvas.id, { title: "Other", expectedTitle: "Stale" }), status(409));
    const renamed = await service.rename(owner, canvas.id, { title: "  Renamed  ", expectedTitle: canvas.title });
    assert.equal(renamed.title, "Renamed");
    assert.equal(renamed.revision, before.revision + 1);
    assert.equal(renamed.visibility, "organization");
    assert.deepEqual((await service.get(member, canvas.id)).scene, before.scene);
    assert.deepEqual(await service.comments.get(member, canvas.id), comments);
    assert.deepEqual(await service.rename(owner, canvas.id, { title: "Renamed", expectedTitle: "Original" }), renamed);
    assert.deepEqual(changes, ["Renamed"]);
    unsubscribe();
    unsubscribe();
    await repository.close();
    repository = await reopenTestRepository(repository);
    service = new CanvasService(repository);
    assert.equal((await service.get(member, canvas.id)).title, "Renamed");
    assert.deepEqual((await service.get(member, canvas.id)).scene, before.scene);
    assert.deepEqual(await service.comments.get(member, canvas.id), comments);
  } finally { await repository.close(); }
});

test("delete checks ownership, exact title and revision, cascades data atomically and clears subscriptions", async () => {
  const repository = await createTestRepository();
  const inspect = testDatabase(repository);
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Delete this" });
    await service.mutate(owner, canvas.id, { elements: [{ id: "image", type: "image", fileId: "asset", version: 1, versionNonce: 1, isDeleted: false }],
      files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 1 } } });
    await service.comments.create(owner, canvas.id, { id: randomUUID(), text: "Delete me too", anchor: { type: "canvas", x: 0, y: 0 } });
    const payload = { confirmTitle: canvas.title, expectedRevision: 1 };
    await assert.rejects(async () => await service.delete(member, canvas.id, payload), status(404));
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    payload.expectedRevision = 2;
    await assert.rejects(async () => await service.delete(member, canvas.id, payload), status(403));
    await assert.rejects(async () => await service.delete(otherOrg, canvas.id, payload), status(404));
    await assert.rejects(async () => await service.delete(owner, canvas.id, { ...payload, confirmTitle: "Wrong" }), status(409));
    await assert.rejects(async () => await service.delete(owner, canvas.id, { ...payload, expectedRevision: 0 }), status(409));
    await assert.rejects(async () => await service.delete(owner, canvas.id, { ...payload, confirm: true }));
    const editor = await service.connectEditor(owner, canvas.id);
    await editor.setSelection(["image"]);
    let notifications = 0;
    const unsubscribe = await service.subscribeDeletion(owner, canvas.id, () => { notifications++; });
    let oldSubscriptions = 0;
    await service.subscribe(owner, canvas.id, () => { oldSubscriptions++; });
    await service.subscribeMetadata(owner, canvas.id, () => { oldSubscriptions++; });
    await service.comments.subscribe(owner, canvas.id, () => { oldSubscriptions++; });
    // A failure in a cascaded child deletion must roll the parent and assets back.
    await inspect.query(`CREATE FUNCTION fail_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$;
      CREATE TRIGGER fail_delete BEFORE DELETE ON comments FOR EACH ROW EXECUTE FUNCTION fail_delete()`);
    await assert.rejects(async () => await service.delete(owner, canvas.id, payload));
    assert.equal(notifications, 0);
    assert((await service.get(member, canvas.id)).scene.files.asset);
    assert.equal((await service.comments.get(member, canvas.id)).comments.length, 1);
    await inspect.query("DROP TRIGGER fail_delete ON comments");
    assert.deepEqual(await service.delete(owner, canvas.id, payload), { canvasId: canvas.id, deleted: true });
    assert.equal(notifications, 1);
    for (const table of ["canvases", "assets", "comments"]) assert.equal((await inspect.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0]?.count, 0);
    assert.equal(await repository.get(canvas.id), undefined);
    await assert.rejects(async () => await service.get(owner, canvas.id), status(404));
    await assert.rejects(async () => await service.delete(owner, canvas.id, payload), status(404));
    // Reusing this ID through the test adapter cannot resurrect old listeners.
    await repository.create(canvas);
    await service.mutate(owner, canvas.id, { elements: [{ id: "box", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false }] });
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    await service.comments.create(owner, canvas.id, { id: randomUUID(), text: "New note", anchor: { type: "canvas", x: 1, y: 1 } });
    assert.equal((await service.getSelectedElements(owner, canvas.id)).editors.length, 0);
    assert.equal(oldSubscriptions, 0);
    await editor.close();
    unsubscribe();
    unsubscribe();
  } finally { await repository.close(); }
});

test("failed rename and stale delete persistence never publish or remove data", async t => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Keep" });
    let published = 0;
    await service.subscribeMetadata(owner, canvas.id, () => { published++; });
    await service.subscribeDeletion(owner, canvas.id, () => { published++; });
    t.mock.method(repository, "rename", () => undefined);
    t.mock.method(repository, "delete", () => false);
    await assert.rejects(async () => await service.rename(owner, canvas.id, { title: "New", expectedTitle: "Keep" }), status(409));
    await assert.rejects(async () => await service.delete(owner, canvas.id, { confirmTitle: "Keep", expectedRevision: 0 }), status(409));
    assert.equal(published, 0);
    assert.equal((await service.get(owner, canvas.id)).title, "Keep");
    assert.equal((await service.get(owner, canvas.id)).revision, 0);
  } finally { await repository.close(); }
});
