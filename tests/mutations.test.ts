import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { Scene } from "../src/shared/canvas.js";

const owner = { userId: "owner", organizationId: "org" };
function element(id: string, index: string, version = 1, versionNonce = 1): Scene["elements"][number] {
  return { id, index, type: "rectangle", version, versionNonce, isDeleted: false };
}

test("incremental mutations retain unrelated elements, tombstones and binding fields", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  try {
    const canvas = service.create(owner, { title: "Incremental" });
    const shape = { ...element("shape", "a0"), boundElements: [{ id: "arrow", type: "arrow" }] };
    const arrow = { ...element("arrow", "a1"), type: "arrow", startBinding: { elementId: "shape", focus: 0, gap: 1 }, endBinding: null, points: [[0, 0], [100, 100]] };
    const events: number[] = [];
    const unsubscribe = service.subscribe(owner, canvas.id, (update) => {
      assert.equal(service.get(owner, canvas.id).revision, update.revision, "publish must happen after commit");
      events.push(update.revision);
    });
    service.mutate(owner, canvas.id, { elements: [shape, arrow] });
    service.mutate(owner, canvas.id, { elements: [{ ...shape, version: 2, versionNonce: 20, width: 200 }] });
    let stored = service.get(owner, canvas.id);
    assert.equal(stored.scene.elements.length, 2);
    assert.deepEqual(stored.scene.elements.find((item) => item.id === "arrow")?.startBinding, arrow.startBinding);
    service.mutate(owner, canvas.id, { elements: [{ ...arrow, version: 2, versionNonce: 30, isDeleted: true }] });
    stored = service.get(owner, canvas.id);
    assert.equal(stored.scene.elements.find((item) => item.id === "arrow")?.isDeleted, true);
    assert.equal(stored.scene.elements.find((item) => item.id === "shape")?.width, 200);
    assert.deepEqual(events, [1, 2, 3]);
    unsubscribe();
    assert.throws(() => service.mutate(owner, canvas.id, { elements: [], expectedRevision: 0 }),
      (error: unknown) => error instanceof ServiceError && error.status === 409);
    assert.equal(service.get(owner, canvas.id).revision, 3);
    assert.throws(() => service.subscribe({ userId: "other", organizationId: "org" }, canvas.id, () => {}));
  } finally { repository.close(); }
});

test("same-element conflicts follow native version and lowest-nonce rules in either arrival order", () => {
  for (const order of [[90, 10], [10, 90]]) {
    const repository = new SqliteCanvasRepository(":memory:");
    const service = new CanvasService(repository);
    try {
      const canvas = service.create(owner, { title: "Conflict" });
      service.mutate(owner, canvas.id, { elements: [element("a", "a0")] });
      for (const nonce of order) service.mutate(owner, canvas.id, { elements: [{ ...element("a", "a0", 2, nonce), width: nonce }] });
      assert.equal(service.get(owner, canvas.id).scene.elements[0]?.width, 10);
      const revision = service.get(owner, canvas.id).revision;
      const stale = service.mutate(owner, canvas.id, { elements: [element("a", "a0", 1, 0)] });
      assert.equal(stale.revision, revision, "discarded edits are acknowledged without a new revision");
      assert.equal(stale.elements[0]?.versionNonce, 10, "ack returns authoritative winner");
    } finally { repository.close(); }
  }
});

test("fractional ordering, equal-index repair, reorder and undo-style higher versions converge", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  try {
    const canvas = service.create(owner, { title: "Ordering" });
    service.mutate(owner, canvas.id, { elements: [element("b", "a0")] });
    const update = service.mutate(owner, canvas.id, { elements: [element("a", "a0")] });
    let elements = service.get(owner, canvas.id).scene.elements;
    assert.deepEqual(elements.map((item) => item.id), ["a", "b"]);
    assert.ok(elements[0]!.index! < elements[1]!.index!);
    assert.equal(elements[0]!.index, "a0");
    assert.equal(elements[1]!.index, "a1");
    assert.equal(update.elements.find((item) => item.id === "b")?.version, 2);
    const a = elements[0]!;
    service.mutate(owner, canvas.id, { elements: [{ ...a, version: a.version + 1, versionNonce: 3, index: "a2" }] });
    assert.deepEqual(service.get(owner, canvas.id).scene.elements.map((item) => item.id), ["b", "a"]);
    service.mutate(owner, canvas.id, { elements: [{ ...a, version: a.version + 2, versionNonce: 4 }] });
    elements = service.get(owner, canvas.id).scene.elements;
    assert.deepEqual(elements.map((item) => item.id), ["a", "b"]);
    assert.throws(() => service.mutate(owner, canvas.id, { elements: [element("bad", "invalid")] }));
  } finally { repository.close(); }
});

test("failed transactions never publish or advance revisions", () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  try {
    const canvas = service.create(owner, { title: "Failure" });
    let published = false;
    service.subscribe(owner, canvas.id, () => { published = true; });
    repository.commit = () => { throw new Error("Simulated storage failure"); };
    assert.throws(() => service.mutate(owner, canvas.id, { elements: [element("a", "a0")] }));
    assert.equal(published, false);
    assert.equal(service.get(owner, canvas.id).revision, 0);
  } finally { repository.close(); }
});
