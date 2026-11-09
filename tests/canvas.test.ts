import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { createTestRepository, reopenTestRepository } from "./postgres.js";
import type { Scene } from "../src/shared/canvas.js";

const owner = { userId: "owner", organizationId: "org-a" };
const member = { userId: "member", organizationId: "org-a" };
const otherOrg = { userId: "owner", organizationId: "org-b" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";

function scene(): Scene {
  return {
    elements: [
      { id: "image", type: "image", version: 2, versionNonce: 42, isDeleted: false, fileId: "asset", index: "a0", boundElements: [{ id: "arrow", type: "arrow" }] },
      { id: "deleted", type: "rectangle", version: 3, versionNonce: 5, isDeleted: true, index: "a1" },
    ],
    sharedSettings: { viewBackgroundColor: "#fafafa" },
    files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 123 } },
  };
}

function status(expected: number) {
  return (error: unknown) => error instanceof ServiceError && error.status === expected;
}

test("create, save and reopen scenes and separate assets across database restarts", async () => {
  let repository = await createTestRepository();
  try {
    let service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "  Persistent canvas  " });
    assert.equal(canvas.title, "Persistent canvas");
    assert.equal(canvas.visibility, "private");
    assert.equal(canvas.creatorUserId, owner.userId);
    assert.equal(canvas.organizationId, owner.organizationId);
    assert.equal(canvas.revision, 0);
    const saved = await service.save(owner, canvas.id, { expectedRevision: 0, scene: scene() });
    assert.equal(saved.revision, 1);
    await repository.close();
    repository = await reopenTestRepository(repository);
    service = new CanvasService(repository);
    assert.deepEqual((await service.get(owner, canvas.id)).scene, scene());
    assert.equal((await service.list(owner))[0]?.id, canvas.id);
    assert.equal((await service.get(owner, canvas.id)).revision, 1);
    await assert.rejects(async () => await service.save(owner, canvas.id, { expectedRevision: 0, scene: canvas.scene }), status(409));
    assert.deepEqual((await service.get(owner, canvas.id)).scene, scene());
    assert.equal((await service.get(owner, canvas.id)).revision, 1);
  } finally {
    await repository.close();
  }
});

test("ownership and organization checks apply to listing, reads and saves", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Private" });
    for (const context of [member, otherOrg]) {
      assert.deepEqual(await service.list(context), []);
      await assert.rejects(async () => await service.get(context, canvas.id), status(404));
      await assert.rejects(async () => await service.save(context, canvas.id, { expectedRevision: 0, scene: canvas.scene }), status(404));
    }
    await repository.create({ ...canvas, id: "org-visible", visibility: "organization" });
    assert.equal((await service.get(member, "org-visible")).id, "org-visible");
    assert.equal((await service.list(member)).length, 1);
    await assert.rejects(async () => await service.get(otherOrg, "org-visible"), status(404));
    await assert.rejects(async () => await service.create(owner, { title: "Injected", organizationId: "org-b" }));
  } finally { await repository.close(); }
});

test("Postgres rolls scene, revision and assets back together after a mid-commit failure", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Atomic commit" });
    await service.save(owner, canvas.id, { expectedRevision: 0, scene: scene() });
    const invalid = scene();
    invalid.elements = [];
    invalid.files.asset!.dataURL = "no base64 separator";
    // Exercise the adapter directly: this throws after the scene UPDATE,
    // proving its transaction rolls back even when the application is bypassed.
    await assert.rejects(async () => await repository.commit(canvas.id, {
      expectedRevision: 1, scene: invalid, assets: { upsert: invalid.files, remove: [] },
    }, new Date().toISOString()));
    const restored = await service.get(owner, canvas.id);
    assert.equal(restored.revision, 1);
    assert.deepEqual(restored.scene, scene());
  } finally { await repository.close(); }
});

test("invalid images, duplicate elements and unshared editor settings cannot modify committed state", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Validation" });
    const invalid = scene();
    invalid.files.asset!.dataURL = "data:image/png;base64,not base64";
    await assert.rejects(async () => await service.save(owner, canvas.id, { expectedRevision: 0, scene: invalid }), status(400));
    const duplicates = scene();
    duplicates.elements.push(duplicates.elements[0]!);
    await assert.rejects(async () => await service.save(owner, canvas.id, { expectedRevision: 0, scene: duplicates }), status(400));
    const missing = scene();
    missing.files = {};
    await assert.rejects(async () => await service.save(owner, canvas.id, { expectedRevision: 0, scene: missing }), status(400));
    await assert.rejects(async () => await service.save(owner, canvas.id, {
      expectedRevision: 0, scene: { ...scene(), sharedSettings: { viewBackgroundColor: "#fff", selectedElementIds: {} } },
    }));
    assert.equal((await service.get(owner, canvas.id)).revision, 0);
    assert.deepEqual((await service.get(owner, canvas.id)).scene.elements, []);
  } finally { await repository.close(); }
});
