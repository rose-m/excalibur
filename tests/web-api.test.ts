import assert from "node:assert/strict";
import { test } from "node:test";
import { api, configureApi } from "../src/web/api.js";

test("browser API requests send the current bearer token without an org-selection header", async t => {
  let token = "first-token";
  const headers: Headers[] = [];
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    headers.push(new Headers(init?.headers));
    return Response.json([]);
  });
  configureApi(() => ({ token }));
  try {
    await api.list();
    token = "refreshed-token";
    await api.list();
    assert.equal(headers[0]!.get("authorization"), "Bearer first-token");
    assert.equal(headers[1]!.get("authorization"), "Bearer refreshed-token");
    for (const value of headers) assert.equal(value.get("x-organization-id"), null);
    configureApi();
    await api.list();
    assert.equal(headers[2]!.get("authorization"), null);
  } finally { configureApi(); }
});
