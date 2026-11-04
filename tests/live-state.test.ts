import assert from "node:assert/strict";
import { test } from "node:test";
import type { Scene } from "../src/shared/canvas.js";
import { applyUpdate, pendingMutation } from "../src/web/live-state.js";

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
