import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scene } from "../src/shared/canvas.js";
import { applyUpdate, pendingMutation, SceneDiffer } from "../src/web/live-state.js";

test("client diffs send only changed elements/files/settings and keep deleted elements", () => {
  const known: Scene = {
    elements: [{ id: "a", type: "rectangle", index: "a0", version: 1, versionNonce: 1, isDeleted: false }],
    files: {}, sharedSettings: { viewBackgroundColor: "#fff" },
  };
  assert.equal(pendingMutation(known, structuredClone(known)), null);
  const local = structuredClone(known);
  local.elements[0]!.isDeleted = true;
  local.elements[0]!.version++;
  const mutation = pendingMutation(known, local)!;
  assert.equal(mutation.elements.length, 1);
  assert.equal(mutation.elements[0]!.isDeleted, true);
  assert.deepEqual(mutation.files, {});
  assert.equal(mutation.sharedSettings, undefined);
  const merged = applyUpdate(known, { revision: 1, elements: mutation.elements, files: {}, sharedSettings: known.sharedSettings });
  assert.equal(pendingMutation(merged, local), null, "remote/ack updates must not echo back");
  const remote = { id: "b", type: "rectangle", index: "a1", version: 1, versionNonce: 2, isDeleted: false };
  const added = applyUpdate(merged, { revision: 2, elements: [remote], files: {}, sharedSettings: known.sharedSettings });
  assert.deepEqual(added.elements.map((item) => item.id), ["a", "b"]);
  assert.equal(added.elements[0]!.isDeleted, true);
});

test("image diffs ignore retrieval/creation metadata but preserve new content", () => {
  const known: Scene = {
    elements: [], sharedSettings: { viewBackgroundColor: "#fff" },
    files: { asset: { id: "asset", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 } },
  };
  const local = structuredClone(known);
  local.files.asset!.created = 2;
  assert.equal(pendingMutation(known, local), null);
  local.files.asset!.dataURL = "data:image/png;base64,AQ==";
  assert.equal(Object.keys(pendingMutation(known, local)!.files).length, 1);
});

test("fast dirty detection tracks native versions, nonces, order, deletions, files and settings", () => {
  const known: Scene = {
    elements: [{ id: "a", type: "rectangle", index: "a0", version: 1, versionNonce: 1, isDeleted: false }],
    files: {}, sharedSettings: { viewBackgroundColor: "#fff" },
  };
  const differ = new SceneDiffer(known);
  assert.equal(differ.hasChanges(structuredClone(known)), false);
  for (const changes of [{ version: 2 }, { versionNonce: 2 }, { index: "a1" }, { isDeleted: true }]) {
    const local = structuredClone(known);
    Object.assign(local.elements[0]!, changes);
    assert.equal(differ.hasChanges(local), true);
  }
  const added = structuredClone(known);
  added.elements.push({ ...known.elements[0]!, id: "new" });
  assert.equal(differ.hasChanges(added), true);
  const background = structuredClone(known);
  background.sharedSettings.viewBackgroundColor = "#000";
  assert.equal(differ.hasChanges(background), true);
  const image = structuredClone(known);
  image.files.asset = { id: "asset", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 };
  assert.equal(differ.hasChanges(image), true);
});

test("exact diffs cache authoritative fingerprints but still detect fields without native version changes", () => {
  let reads = 0;
  const known: Scene = {
    elements: [{ id: "a", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false,
      get width() { reads++; return 100; } }],
    files: {}, sharedSettings: { viewBackgroundColor: "#fff" },
  };
  const local = structuredClone(known);
  reads = 0;
  const differ = new SceneDiffer(known);
  assert.equal(differ.hasChanges(local), false);
  assert.equal(reads, 0);
  assert.equal(differ.mutation(local), null);
  assert.equal(reads, 1);
  local.elements[0]!.width = 200;
  assert.equal(differ.mutation(local)!.elements[0]!.width, 200);
  assert.equal(reads, 1, "the unchanged authoritative baseline must not be reserialized");
});
