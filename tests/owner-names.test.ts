import assert from "node:assert/strict";
import { test } from "node:test";
import { userDisplayNames } from "../src/server/auth/user-display-names.js";
import type { Authentication } from "../src/server/auth/propelauth.js";
import { CanvasService } from "../src/server/canvas/service.js";
import { createApp } from "../src/server/http/app.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { CanvasListItem } from "../src/shared/canvas.js";

test("owner names prefer verified-profile usernames, then full names, never IDs or emails", async () => {
  const result = await userDisplayNames(["alice", "bob", "missing", "unnamed", "mismatch"], async () => ({
    alice: { userId: "alice", username: "  alice-design  ", firstName: "Alice", lastName: "Example" },
    bob: { userId: "bob", username: " ", firstName: " Bob ", lastName: " Example " },
    unnamed: { userId: "unnamed", username: null, firstName: null, lastName: null, email: "private@example.com" },
    mismatch: { userId: "someone-else", username: "Wrong user" },
    unrelated: { userId: "unrelated", username: "Not requested" },
  }));
  assert.deepEqual([...result], [["alice", "alice-design"], ["bob", "Bob Example"]]);
});

test("owner lookups are deduplicated and batched; a directory failure does not discard successful batches", async () => {
  const ids = Array.from({ length: 101 }, (_, index) => `user-${index}`);
  const batches: string[][] = [];
  const result = await userDisplayNames([...ids, ids[0]!], async batch => {
    batches.push(batch);
    if (batch.length === 100) throw new Error("Private directory details");
    return { "user-100": { userId: "user-100", username: "last-owner" } };
  });
  assert.deepEqual(batches.map(batch => batch.length), [100, 1]);
  assert.deepEqual([...result], [["user-100", "last-owner"]]);
  let called = false;
  assert.equal((await userDisplayNames([], async () => { called = true; return {}; })).size, 0);
  assert.equal(called, false);
});

test("overview resolves owner names only for already-accessible canvases, without exposing directory records", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const viewer = { userId: "alice", organizationId: "org-a" };
  const bob = { userId: "bob", organizationId: "org-a" };
  const own = service.create(viewer, { title: "Mine" });
  const shared = service.create(bob, { title: "Shared" });
  const anotherShared = service.create(bob, { title: "Also shared" });
  for (const canvas of [shared, anotherShared]) service.setVisibility(bob, canvas.id, { visibility: "organization", expectedVisibility: "private" });
  service.create({ userId: "private-owner", organizationId: "org-a" }, { title: "Not visible" });
  service.create({ userId: "other-org-owner", organizationId: "org-b" }, { title: "Other org" });
  const calls: string[][] = [];
  const principal = { userId: "alice", organizations: [{ id: "org-a", name: "A" }] };
  let offline = false;
  const auth: Authentication = {
    authUrl: "https://auth.example",
    authenticate: async () => principal,
    getPrincipal: async () => principal,
    getUserDisplayNames: async ids => {
      calls.push([...ids]);
      if (offline) throw new Error("Directory failure with sensitive details");
      return new Map([["alice", "alice-design"], ["bob", "bob-engineering"], ["unrelated", "Must not be exposed"]]);
    },
  };
  const app = createApp(service, "dist/web", 3000, "https://draw.example", {}, auth);
  const request = () => app.request("https://draw.example/api/canvases", { headers: { host: "draw.example", authorization: "Bearer viewer" } });
  try {
    const response = await request();
    assert.equal(response.status, 200);
    const items = await response.json() as CanvasListItem[];
    assert.deepEqual(new Set(calls[0]), new Set(["alice", "bob"]));
    assert.equal(calls[0]?.length, 2);
    assert.equal(items.length, 3);
    assert.equal(items.find(canvas => canvas.id === own.id)?.ownerName, "alice-design");
    assert.equal(items.find(canvas => canvas.id === shared.id)?.ownerName, "bob-engineering");
    assert.equal(items.find(canvas => canvas.id === shared.id)?.creatorUserId, "bob");
    assert(!JSON.stringify(items).includes("Must not be exposed"));
    assert(!JSON.stringify(items).includes("email"));
    offline = true;
    const fallback = await request();
    assert.equal(fallback.status, 200);
    const withoutNames = await fallback.json() as CanvasListItem[];
    assert(withoutNames.every(canvas => canvas.ownerName === null));
    assert(!JSON.stringify(withoutNames).includes("sensitive"));
  } finally { await app.closeMcp(); repository.close(); }
});
