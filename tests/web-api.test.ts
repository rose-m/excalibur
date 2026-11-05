import assert from "node:assert/strict";
import { test } from "node:test";
import { api, configureApi } from "../src/web/api.js";

test("browser API requests send current credentials and the selected organization", async t => {
  let token = "first-token";
  let organizationId: string | undefined;
  const headers: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return Response.json([]);
  });
  configureApi(() => ({ token, organizationId }));
  try {
    await api.list();
    token = "refreshed-token";
    organizationId = "org-b";
    await api.list();
    assert.equal(headers[0]!.get("authorization"), "Bearer first-token");
    assert.equal(headers[1]!.get("authorization"), "Bearer refreshed-token");
    assert.equal(headers[0]!.get("x-organization-id"), null);
    assert.equal(headers[1]!.get("x-organization-id"), "org-b");
    configureApi();
    await api.list();
    assert.equal(headers[2]!.get("authorization"), null);
    assert.equal(headers[2]!.get("x-organization-id"), null);
  } finally { configureApi(); }
});
