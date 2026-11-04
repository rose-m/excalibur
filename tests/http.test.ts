import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { resolve } from "node:path";
import { CanvasService } from "../src/server/canvas/service.js";
import { createHandler } from "../src/server/http/app.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { CanvasDocument } from "../src/shared/canvas.js";

test("HTTP lifecycle, conflicts, validation and local-only safeguards", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const handler = createHandler(new CanvasService(repository), resolve("dist/web"), 3000);
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    const created = await fetch(`${base}/api/canvases`, post({ title: "HTTP canvas" }));
    assert.equal(created.status, 201);
    const canvas = await created.json() as CanvasDocument;
    assert.equal((await fetch(`${base}/api/canvases/${canvas.id}`)).status, 200);
    const save = { ...post({ expectedRevision: 0, scene: canvas.scene }), method: "PUT" };
    assert.equal((await fetch(`${base}/api/canvases/${canvas.id}`, save)).status, 200);
    assert.equal((await fetch(`${base}/api/canvases/${canvas.id}`, save)).status, 409);
    assert.equal((await fetch(`${base}/api/canvases`, post({ title: " " }))).status, 400);
    assert.equal((await fetch(`${base}/api/canvases`, post({ title: "Fake identity", userId: "attacker" }))).status, 400);
    assert.equal((await fetch(`${base}/api/canvases`, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await fetch(`${base}/api/canvases`, { ...post({ title: "Bad JSON" }), body: "{" })).status, 400);
    assert.equal((await fetch(`${base}/api/canvases`, { headers: { origin: "https://unrelated.example" } })).status, 403);
    const badHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${base}/api/canvases`, { headers: { host: "unrelated.example" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(`${base}/api/canvases`, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(`${base}/api/unknown`)).status, 404);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/api/canvases`, { method: "DELETE" })).status, 405);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    repository.close();
  }
});
