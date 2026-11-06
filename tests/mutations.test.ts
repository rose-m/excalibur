import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { createTestRepository } from "./postgres.js";
import type { Scene } from "../src/shared/canvas.js";

const owner = { userId: "owner", organizationId: "org" };
function element(id: string, index: string, version = 1, versionNonce = 1): Scene["elements"][number] {
  return { id, index, type: "rectangle", version, versionNonce, isDeleted: false };
}

test("incremental mutations retain unrelated elements, tombstones and binding fields", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  try {
    const canvas = await service.create(owner, { title: "Incremental" });
    const shape = { ...element("shape", "a0"), boundElements: [{ id: "arrow", type: "arrow" }] };
    const arrow = { ...element("arrow", "a1"), type: "arrow", startBinding: { elementId: "shape", focus: 0, gap: 1 }, endBinding: null, points: [[0, 0], [100, 100]] };
    const events: number[] = [];
    const unsubscribe = await service.subscribe(owner, canvas.id, async (update) => {
      assert.equal((await service.get(owner, canvas.id)).revision, update.revision, "publish must happen after commit");
      events.push(update.revision);
    });
    await service.mutate(owner, canvas.id, { elements: [shape, arrow] });
    await service.mutate(owner, canvas.id, { elements: [{ ...shape, version: 2, versionNonce: 20, width: 200 }] });
    let stored = await service.get(owner, canvas.id);
    assert.equal(stored.scene.elements.length, 2);
    assert.deepEqual(stored.scene.elements.find((item) => item.id === "arrow")?.startBinding, arrow.startBinding);
    await service.mutate(owner, canvas.id, { elements: [{ ...arrow, version: 2, versionNonce: 30, isDeleted: true }] });
    stored = await service.get(owner, canvas.id);
    assert.equal(stored.scene.elements.find((item) => item.id === "arrow")?.isDeleted, true);
    assert.equal(stored.scene.elements.find((item) => item.id === "shape")?.width, 200);
    assert.deepEqual(events, [1, 2, 3]);
    unsubscribe();
    await assert.rejects(async () => await service.mutate(owner, canvas.id, { elements: [], expectedRevision: 0 }),
      (error: unknown) => error instanceof ServiceError && error.status === 409);
    assert.equal((await service.get(owner, canvas.id)).revision, 3);
    await assert.rejects(async () => await service.subscribe({ userId: "other", organizationId: "org" }, canvas.id, () => {}));
  } finally { await repository.close(); }
});

test("same-element conflicts follow native version and lowest-nonce rules in either arrival order", async () => {
  for (const order of [[90, 10], [10, 90]]) {
    const repository = await createTestRepository();
    const service = new CanvasService(repository);
    try {
      const canvas = await service.create(owner, { title: "Conflict" });
      await service.mutate(owner, canvas.id, { elements: [element("a", "a0")] });
      for (const nonce of order) await service.mutate(owner, canvas.id, { elements: [{ ...element("a", "a0", 2, nonce), width: nonce }] });
      assert.equal((await service.get(owner, canvas.id)).scene.elements[0]?.width, 10);
      const revision = (await service.get(owner, canvas.id)).revision;
      const stale = await service.mutate(owner, canvas.id, { elements: [element("a", "a0", 1, 0)] });
      assert.equal(stale.revision, revision, "discarded edits are acknowledged without a new revision");
      assert.equal(stale.elements[0]?.versionNonce, 10, "ack returns authoritative winner");
    } finally { await repository.close(); }
  }
});

test("fractional ordering, equal-index repair, reorder and undo-style higher versions converge", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  try {
    const canvas = await service.create(owner, { title: "Ordering" });
    await service.mutate(owner, canvas.id, { elements: [element("b", "a0")] });
    const update = await service.mutate(owner, canvas.id, { elements: [element("a", "a0")] });
    let elements = (await service.get(owner, canvas.id)).scene.elements;
    assert.deepEqual(elements.map((item) => item.id), ["a", "b"]);
    assert.ok(elements[0]!.index! < elements[1]!.index!);
    assert.equal(elements[0]!.index, "a0");
    assert.equal(elements[1]!.index, "a1");
    assert.equal(update.elements.find((item) => item.id === "b")?.version, 2);
    const a = elements[0]!;
    await service.mutate(owner, canvas.id, { elements: [{ ...a, version: a.version + 1, versionNonce: 3, index: "a2" }] });
    assert.deepEqual((await service.get(owner, canvas.id)).scene.elements.map((item) => item.id), ["b", "a"]);
    await service.mutate(owner, canvas.id, { elements: [{ ...a, version: a.version + 2, versionNonce: 4 }] });
    elements = (await service.get(owner, canvas.id)).scene.elements;
    assert.deepEqual(elements.map((item) => item.id), ["a", "b"]);
    await assert.rejects(async () => await service.mutate(owner, canvas.id, { elements: [element("bad", "invalid")] }));
  } finally { await repository.close(); }
});

test("failed transactions never publish or advance revisions", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  try {
    const canvas = await service.create(owner, { title: "Failure" });
    let published = false;
    await service.subscribe(owner, canvas.id, () => { published = true; });
    repository.commit = () => { throw new Error("Simulated storage failure"); };
    await assert.rejects(async () => await service.mutate(owner, canvas.id, { elements: [element("a", "a0")] }));
    assert.equal(published, false);
    assert.equal((await service.get(owner, canvas.id)).revision, 0);
  } finally { await repository.close(); }
});

test("repeated unsubscribe cannot remove a replacement canvas room", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  try {
    const canvas = await service.create(owner, { title: "Room replacement" });
    const oldCleanup = await service.subscribe(owner, canvas.id, () => assert.fail("Old subscriber was not removed"));
    oldCleanup();
    let received = 0;
    const cleanup = await service.subscribe(owner, canvas.id, () => { received++; });
    oldCleanup();
    await service.mutate(owner, canvas.id, { elements: [element("a", "a0")] });
    assert.equal(received, 1);
    oldCleanup();
    await service.mutate(owner, canvas.id, { elements: [element("b", "a1")] });
    assert.equal(received, 2);
    cleanup();
    cleanup();
    await service.mutate(owner, canvas.id, { elements: [element("c", "a2")] });
    assert.equal(received, 2);
  } finally { await repository.close(); }
});
