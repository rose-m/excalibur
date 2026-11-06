import assert from "node:assert/strict";
import { test } from "node:test";
import { organizationStorageKey, organizationUrl, removeOrganizationQuery, selectOrganization } from "../src/web/organizations.js";
import { JSDOM } from "jsdom";

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

test("cleaning the organization query preserves router history state and other URL fields", () => {
  const dom = new JSDOM("", { url: "https://draw.example/canvases/id?organization=org-b&other=value#anchor" });
  try {
    const state = { idx: 3, key: "router-entry", usr: { from: "canvases" } };
    dom.window.history.replaceState(state, "");
    removeOrganizationQuery(new URL(dom.window.location.href), dom.window.history);
    assert.deepEqual(dom.window.history.state, state);
    assert.equal(dom.window.location.href, "https://draw.example/canvases/id?other=value#anchor");
  } finally { dom.window.close(); }
});
