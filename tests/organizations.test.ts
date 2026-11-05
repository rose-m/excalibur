import assert from "node:assert/strict";
import { test } from "node:test";
import { organizationStorageKey, organizationUrl, selectOrganization } from "../src/web/organizations.js";

const a = { id: "org-a", name: "A" };
const b = { id: "org-b", name: "B" };

test("browser organization selection requires membership and does not guess for multiple orgs", () => {
  assert.equal(selectOrganization([], null, null), undefined);
  assert.equal(selectOrganization([a], null, null), a.id);
  assert.equal(selectOrganization([a, b], null, null), undefined);
  assert.equal(selectOrganization([a, b], null, b.id), b.id);
  assert.equal(selectOrganization([a, b], a.id, b.id), a.id);
  assert.equal(selectOrganization([a, b], "removed-org", b.id), undefined);
  assert.equal(selectOrganization([a, b], null, "removed-org"), undefined);
  assert.equal(selectOrganization([a], null, "removed-org"), a.id);
  assert.equal(selectOrganization([a], "removed-org", null), undefined);
  assert.equal(selectOrganization([a], "", null), undefined);
});

test("browser selection is user-scoped and switching returns to the list while initial selection preserves deep links", () => {
  assert.notEqual(organizationStorageKey("alice"), organizationStorageKey("bob"));
  assert.equal(organizationUrl(b.id), "/?organization=org-b");
  assert.equal(organizationUrl(a.id, "/canvases/id"), "/canvases/id?organization=org-a");
  assert.equal(organizationUrl("a&b"), "/?organization=a%26b");
});
