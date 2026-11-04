import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { Scene } from "../src/shared/canvas.js";

const owner = { userId: "owner", organizationId: "org-a" };
const member = { userId: "member", organizationId: "org-a" };
const otherOrg = { userId: "owner", organizationId: "org-b" };
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=";

function scene(): Scene {
  return {
    elements: [
      { id: "image", type: "image", version: 2, versionNonce: 42, isDeleted: false, fileId: "asset", index: "a0", boundElements: [{ id: "arrow", type: "arrow" }] },
      { id: "deleted", type: "rectangle", version: 3, versionNonce: 5, isDeleted: true },
    ],
    sharedSettings: { viewBackgroundColor: "#fafafa" },
    files: { asset: { id: "asset", mimeType: "image/png", dataURL: `data:image/png;base64,${png}`, created: 123 } },
  };
}

function status(expected: number) {
  return (error: unknown) => error instanceof ServiceError && error.status === expected;
}

test("create, save and reopen scenes and separate assets across database restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "excalibur-test-"));
  const filename = join(directory, "test.sqlite");
  let repository = new SqliteCanvasRepository(filename);
  try {
    let service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "  Persistent canvas  " });
    assert.equal(canvas.title, "Persistent canvas");
    assert.equal(canvas.visibility, "private");
    assert.equal(canvas.creatorUserId, owner.userId);
    assert.equal(canvas.organizationId, owner.organizationId);
    assert.equal(canvas.revision, 0);
    const saved = service.save(owner, canvas.id, { expectedRevision: 0, scene: scene() });
    assert.equal(saved.revision, 1);
    repository.close();
    repository = new SqliteCanvasRepository(filename);
    service = new CanvasService(repository);
    assert.deepEqual(service.get(owner, canvas.id).scene, scene());
    assert.equal(service.list(owner)[0]?.id, canvas.id);
    assert.equal(service.get(owner, canvas.id).revision, 1);
    assert.throws(() => service.save(owner, canvas.id, { expectedRevision: 0, scene: canvas.scene }), status(409));
    assert.deepEqual(service.get(owner, canvas.id).scene, scene());
    assert.equal(service.get(owner, canvas.id).revision, 1);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("ownership and organization checks apply to listing, reads and saves", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  try {
    const service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "Private" });
    for (const context of [member, otherOrg]) {
      assert.deepEqual(service.list(context), []);
      assert.throws(() => service.get(context, canvas.id), status(404));
      assert.throws(() => service.save(context, canvas.id, { expectedRevision: 0, scene: canvas.scene }), status(404));
    }
    repository.create({ ...canvas, id: "org-visible", visibility: "organization" });
    assert.equal(service.get(member, "org-visible").id, "org-visible");
    assert.equal(service.list(member).length, 1);
    assert.throws(() => service.get(otherOrg, "org-visible"), status(404));
    assert.throws(() => service.create(owner, { title: "Injected", organizationId: "org-b" }));
  } finally { repository.close(); }
});

test("invalid images, duplicate elements and unshared editor settings cannot modify committed state", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  try {
    const service = new CanvasService(repository);
    const canvas = service.create(owner, { title: "Validation" });
    const invalid = scene();
    invalid.files.asset!.dataURL = "data:image/png;base64,not base64";
    assert.throws(() => service.save(owner, canvas.id, { expectedRevision: 0, scene: invalid }), status(400));
    const duplicates = scene();
    duplicates.elements.push(duplicates.elements[0]!);
    assert.throws(() => service.save(owner, canvas.id, { expectedRevision: 0, scene: duplicates }), status(400));
    const missing = scene();
    missing.files = {};
    assert.throws(() => service.save(owner, canvas.id, { expectedRevision: 0, scene: missing }), status(400));
    assert.throws(() => service.save(owner, canvas.id, {
      expectedRevision: 0, scene: { ...scene(), sharedSettings: { viewBackgroundColor: "#fff", selectedElementIds: {} } },
    }));
    assert.equal(service.get(owner, canvas.id).revision, 0);
    assert.deepEqual(service.get(owner, canvas.id).scene.elements, []);
  } finally { repository.close(); }
});
