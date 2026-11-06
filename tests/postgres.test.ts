import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { createTestRepository, reopenTestRepository, testDatabase } from "./postgres.js";

const context = { userId: "owner", organizationId: "org" };
const element = (id: string) => ({ id, type: "rectangle", version: 1, versionNonce: 1, isDeleted: false });

test("async service mutations serialize reconciliation and publish in commit order", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(context, { title: "Concurrent edits" });
    const revisions: number[] = [];
    await service.subscribe(context, canvas.id, update => revisions.push(update.revision));
    await Promise.all(Array.from({ length: 20 }, (_, i) => service.mutate(context, canvas.id, { elements: [element(`shape-${i}`)] })));
    const stored = await service.get(context, canvas.id);
    assert.equal(stored.scene.elements.length, 20);
    assert.equal(stored.revision, 20);
    assert.deepEqual(revisions, Array.from({ length: 20 }, (_, i) => i + 1));
    const [failed, succeeded] = await Promise.allSettled([
      service.mutate(context, canvas.id, { elements: [element("stale")], expectedRevision: 0 }),
      service.mutate(context, canvas.id, { elements: [element("after-failure")] }),
    ]);
    assert.equal(failed.status, "rejected");
    assert.equal(succeeded.status, "fulfilled", "a failed operation must not poison the canvas queue");
    assert.equal((await service.get(context, canvas.id)).revision, 21);
  } finally { await repository.close(); }
});

test("Postgres revision checks admit only one concurrent commit across pools", async () => {
  const repository = await createTestRepository();
  const other = await reopenTestRepository(repository);
  try {
    const canvas = await new CanvasService(repository).create(context, { title: "CAS" });
    const results = await Promise.all([repository, other].map((connection, i) => connection.commit(canvas.id, {
      expectedRevision: 0, scene: { ...canvas.scene, elements: [element(`winner-${i}`)] },
    }, new Date().toISOString())));
    assert.equal(results.filter(Boolean).length, 1);
    const stored = await other.get(canvas.id);
    assert.equal(stored?.revision, 1);
    assert.equal(stored?.scene.elements[0]?.id, `winner-${results.findIndex(Boolean)}`);
  } finally { await Promise.all([repository.close(), other.close()]); }
});

test("comment row locks enforce idempotency and the capacity limit across pools", async () => {
  const repository = await createTestRepository();
  const other = await reopenTestRepository(repository);
  try {
    const canvas = await new CanvasService(repository).create(context, { title: "Concurrent comments" });
    const comment = { id: randomUUID(), text: "Once", anchor: { type: "canvas" as const, x: 0, y: 0 }, createdAt: new Date().toISOString() };
    const results = await Promise.all([repository.addComment(canvas.id, comment), other.addComment(canvas.id, comment)]);
    for (const result of results) assert.deepEqual(result, { revision: 1, comments: [comment] });
    await testDatabase(repository).query(`INSERT INTO comments (canvas_id, id, text, anchor, created_at)
      SELECT $1, 'seed-' || i, 'Note', $2, $3 FROM generate_series(1, 498) AS i`,
    [canvas.id, JSON.stringify(comment.anchor), comment.createdAt]);
    const capacity = await Promise.all([repository, other].map(connection => connection.addComment(canvas.id, { ...comment, id: randomUUID() })));
    assert.equal(capacity.filter(result => result === "limit").length, 1);
    assert.equal((await repository.getComments(canvas.id)).comments.length, 500);
    assert.equal((await repository.getComments(canvas.id)).revision, 2);
  } finally { await Promise.all([repository.close(), other.close()]); }
});

test("concurrent migration startup is safe and migrations are applied once", async () => {
  const repository = await createTestRepository();
  // Reset only this test's isolated schema to exercise genuinely fresh startup.
  await testDatabase(repository).query("DROP TABLE comments, assets, canvases, migrations");
  const peers = await Promise.all(Array.from({ length: 4 }, () => reopenTestRepository(repository)));
  try {
    const applied = await testDatabase(repository).query("SELECT name FROM migrations ORDER BY name");
    assert.deepEqual(applied.rows.map(row => row.name), ["001_initial.sql", "002_comments.sql"]);
  } finally { await Promise.all([repository, ...peers].map(connection => connection.close())); }
});
