import assert from "node:assert/strict";
import { test } from "node:test";
import { CanvasService } from "../src/server/canvas/service.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import type { Scene } from "../src/shared/canvas.js";
import { createTestRepository, reopenTestRepository, testDatabase } from "./postgres.js";

const owner = { userId: "owner", organizationId: "org" };
const file = (id: string, bytes = Buffer.from([0, 1, 127, 128, 255]), created = 1): Scene["files"][string] => ({
  id, mimeType: "image/png", dataURL: `data:image/png;base64,${bytes.toString("base64")}`, created,
});
const shape = (version: number) => ({ id: "box", type: "rectangle", version, versionNonce: 1, isDeleted: false, width: version });

test("ordinary edits, tombstones, undo and repeated uploads execute no asset DML", async () => {
  let repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "No blob rewrites" });
    const asset = file("asset", Buffer.alloc(256 * 1024, 171));
    const image = { id: "image", type: "image", fileId: asset.id, version: 1, versionNonce: 1, isDeleted: false };
    await service.mutate(owner, canvas.id, { elements: [image], files: { asset } });
    const db = testDatabase(repository);
    const before = (await db.query("SELECT xmin::text, ctid::text, content FROM assets WHERE canvas_id = $1", [canvas.id])).rows;
    // A statement trigger fails even an INSERT/DELETE which affects zero rows.
    // This proves regular edits do not merely hide no-op blob statements.
    await db.query(`CREATE FUNCTION forbid_asset_dml() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected asset DML'; END $$;
      CREATE TRIGGER forbid_asset_dml BEFORE INSERT OR UPDATE OR DELETE ON assets FOR EACH STATEMENT EXECUTE FUNCTION forbid_asset_dml()`);
    for (let version = 1; version <= 5; version++) await service.mutate(owner, canvas.id, { elements: [shape(version)] });
    await service.mutate(owner, canvas.id, { elements: [], sharedSettings: { viewBackgroundColor: "#000" } });
    await service.mutate(owner, canvas.id, { elements: [{ ...image, version: 2, isDeleted: true }] });
    await service.mutate(owner, canvas.id, { elements: [{ ...image, version: 3 }] });
    await service.mutate(owner, canvas.id, { elements: [shape(6)], files: { asset: { ...asset, created: 999 } } });
    await service.rename(owner, canvas.id, { title: "Renamed", expectedTitle: canvas.title });
    await service.setVisibility(owner, canvas.id, { visibility: "organization", expectedVisibility: "private" });
    assert.equal((await service.list(owner))[0]!.title, "Renamed");
    assert.deepEqual((await service.get(owner, canvas.id)).scene.files, { asset });
    assert.deepEqual((await db.query("SELECT xmin::text, ctid::text, content FROM assets WHERE canvas_id = $1", [canvas.id])).rows, before);
    await assert.rejects(service.mutate(owner, canvas.id, { elements: [], files: { asset: file("asset", Buffer.from([42])) } }),
      error => error instanceof ServiceError && error.status === 409);
    const original = await service.get(owner, canvas.id);
    let published = 0;
    await service.subscribe(owner, canvas.id, () => { published++; });
    await assert.rejects(service.mutate(owner, canvas.id, { elements: [shape(7)], files: { new: file("new") } }), /unexpected asset DML/);
    assert.equal(published, 0, "a failed new-asset insert must not publish the scene update");
    assert.deepEqual(await service.get(owner, canvas.id), original);
    await repository.close();
    repository = await reopenTestRepository(repository);
    assert.deepEqual((await repository.get(canvas.id))!.scene.files, { asset });
  } finally { await repository.close(); }
});

test("asset deltas batch inserts, skip identical rows and scope explicit removals to one canvas", async () => {
  const repository = await createTestRepository();
  try {
    const service = new CanvasService(repository);
    const canvas = await service.create(owner, { title: "Asset deltas" });
    const other = await service.create(owner, { title: "Other canvas" });
    const a = file("a");
    const b = file("b", Buffer.from([34, 39, 92, 0, 255]), 123.5);
    const db = testDatabase(repository);
    await repository.commit(canvas.id, { expectedRevision: 0, scene: canvas.scene, assets: { upsert: { a, b }, remove: [] } }, "first");
    await repository.commit(other.id, { expectedRevision: 0, scene: other.scene, assets: { upsert: { a }, remove: [] } }, "first");
    assert.deepEqual((await repository.get(canvas.id))!.scene.files, { a, b }, "binary arrays must round-trip zero/high bytes and fractional creation times");
    await db.query(`CREATE TABLE asset_audit (operation TEXT, asset_id TEXT);
      CREATE FUNCTION audit_assets() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF TG_OP = 'DELETE' THEN INSERT INTO asset_audit VALUES (TG_OP, OLD.asset_id); RETURN OLD; END IF;
        INSERT INTO asset_audit VALUES (TG_OP, NEW.asset_id); RETURN NEW;
      END $$;
      CREATE TRIGGER audit_assets AFTER INSERT OR UPDATE OR DELETE ON assets FOR EACH ROW EXECUTE FUNCTION audit_assets()`);
    await repository.commit(canvas.id, { expectedRevision: 1, scene: canvas.scene, assets: { upsert: { a, b }, remove: [] } }, "second");
    assert.deepEqual((await db.query("SELECT * FROM asset_audit")).rows, [], "identical explicit upserts must not rewrite existing rows");
    const replacement = file("b", Buffer.from([255, 0, 92]), 456.5);
    const c = file("c", Buffer.from(Array.from({ length: 256 }, (_, i) => i)));
    await repository.commit(canvas.id, {
      expectedRevision: 2, scene: canvas.scene, assets: { upsert: { b: replacement, c }, remove: ["a"] },
    }, "third");
    assert.deepEqual((await db.query("SELECT * FROM asset_audit ORDER BY operation, asset_id")).rows, [
      { operation: "DELETE", asset_id: "a" }, { operation: "INSERT", asset_id: "c" }, { operation: "UPDATE", asset_id: "b" },
    ]);
    assert.deepEqual((await repository.get(canvas.id))!.scene.files, { b: replacement, c });
    assert.deepEqual((await repository.get(other.id))!.scene.files, { a });
    // Empty deltas preserve assets even when no image elements reference them.
    await repository.commit(canvas.id, { expectedRevision: 3, scene: canvas.scene, assets: { upsert: {}, remove: [] } }, "fourth");
    assert.deepEqual((await repository.get(canvas.id))!.scene.files, { b: replacement, c });
  } finally { await repository.close(); }
});

test("asset insertion failures roll back scene, revision, asset updates and removals together", async () => {
  const repository = await createTestRepository();
  try {
    const canvas = await new CanvasService(repository).create(owner, { title: "Atomic deltas" });
    const initial = { a: file("a"), b: file("b") };
    await repository.commit(canvas.id, { expectedRevision: 0, scene: canvas.scene, assets: { upsert: initial, remove: [] } }, "initial");
    const before = await repository.get(canvas.id);
    await testDatabase(repository).query(`CREATE FUNCTION fail_asset() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.asset_id = 'bad' THEN RAISE EXCEPTION 'asset write failed'; END IF; RETURN NEW;
      END $$;
      CREATE TRIGGER fail_asset AFTER INSERT ON assets FOR EACH ROW EXECUTE FUNCTION fail_asset()`);
    await assert.rejects(repository.commit(canvas.id, {
      expectedRevision: 1, scene: { ...canvas.scene, elements: [shape(1)] },
      assets: { upsert: { b: file("b", Buffer.from([42])), bad: file("bad") }, remove: ["a"] },
    }, "must roll back"), /asset write failed/);
    assert.deepEqual(await repository.get(canvas.id), before);
    const result = await repository.commit(canvas.id, {
      expectedRevision: 1, scene: canvas.scene, assets: { upsert: {}, remove: ["a"] },
    }, "retry");
    assert.equal(result!.revision, 2);
    assert.deepEqual((await repository.get(canvas.id))!.scene.files, { b: initial.b });
  } finally { await repository.close(); }
});

test("stale asset deltas and ambiguous remove/upsert requests cannot change stored data", async () => {
  const repository = await createTestRepository();
  try {
    const canvas = await new CanvasService(repository).create(owner, { title: "Rejected deltas" });
    const asset = file("asset");
    await repository.commit(canvas.id, { expectedRevision: 0, scene: canvas.scene, assets: { upsert: { asset }, remove: [] } }, "initial");
    const before = await repository.get(canvas.id);
    const stale = await repository.commit(canvas.id, {
      expectedRevision: 0, scene: canvas.scene, assets: { upsert: { new: file("new") }, remove: ["asset"] },
    }, "stale");
    assert.equal(stale, undefined);
    await assert.rejects(repository.commit(canvas.id, {
      expectedRevision: 1, scene: canvas.scene, assets: { upsert: { asset }, remove: ["asset"] },
    }, "invalid"), /cannot be upserted and removed/);
    assert.deepEqual(await repository.get(canvas.id), before);
  } finally { await repository.close(); }
});
