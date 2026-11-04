import assert from "node:assert/strict";
import { test } from "node:test";
import { signature } from "../src/shared/signature.js";
import type { Scene } from "../src/shared/canvas.js";

test("document signatures ignore field order but preserve element order and native mutations", () => {
  const first: Scene = {
    elements: [
      { id: "a", type: "rectangle", version: 1, versionNonce: 2, isDeleted: false, width: 100 },
      { id: "b", type: "rectangle", version: 1, versionNonce: 2, isDeleted: true },
    ],
    sharedSettings: { viewBackgroundColor: "#fff" }, files: {},
  };
  const reordered = JSON.parse(JSON.stringify(first)) as Scene;
  reordered.elements = reordered.elements.map((element) => Object.fromEntries(Object.entries(element).reverse()) as Scene["elements"][number]);
  assert.equal(signature(first), signature(reordered));
  reordered.elements.reverse();
  assert.notEqual(signature(first), signature(reordered));
  const initialSignature = signature(first);
  const snapshot = JSON.parse(initialSignature) as Scene;
  first.elements[0]!.width = 200;
  assert.notEqual(signature(first), initialSignature);
  assert.equal(snapshot.elements[0]!.width, 100);
});
