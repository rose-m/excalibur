import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { CanvasService } from "../src/server/canvas/service.js";
import { createApp } from "../src/server/http/app.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { CanvasDocument } from "../src/shared/canvas.js";

function createWebFixture() {
  const directory = mkdtempSync(join(tmpdir(), "excalibur-http-test-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Excalibur test</title>");
  writeFileSync(join(directory, "assets/app.js"), "console.log('test');");
  return directory;
}

test("HTTP lifecycle, conflicts, validation and local-only safeguards", async () => {
  const webDirectory = createWebFixture();
  const repository = new SqliteCanvasRepository(":memory:");
  const app = createApp(new CanvasService(repository), webDirectory, 3000);
  const server = createServer(getRequestListener(app.fetch));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await fetch(`${base}/health/ready`)).status, 200);
    const created = await fetch(`${base}/api/canvases`, post({ title: "HTTP canvas" }));
    assert.equal(created.status, 201);
    const canvas = await created.json() as CanvasDocument;
    assert.equal(created.headers.get("cache-control"), "no-store");
    assert.equal((await fetch(`${base}/api/canvases/${canvas.id}`)).status, 200);
    const save = { ...post({ expectedRevision: 0, scene: {
      ...canvas.scene,
      elements: [{ id: "http-element", type: "rectangle", version: 1, versionNonce: 1, isDeleted: false, index: "a0" }],
    } }), method: "PUT" };
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
    rmSync(webDirectory, { recursive: true, force: true });
  }
});

test("Hono serves page URLs and static assets without exposing API fallbacks or filesystem paths", async () => {
  const webDirectory = createWebFixture();
  const repository = new SqliteCanvasRepository(":memory:");
  const app = createApp(new CanvasService(repository), webDirectory, 3000);
  function fetchApp(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("host", "localhost:3000");
    return app.request(`http://localhost:3000${path}`, { ...init, headers });
  }
  try {
    for (const path of ["/", "/canvases/932dd1ec-c59c-48ac-a8cc-58f6fcab9b14"]) {
      const response = await fetchApp(path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type")!, /text\/html/);
      assert.equal(response.headers.get("cache-control"), "no-cache");
      assert.match(await response.text(), /Excalibur test/);
      const head = await fetchApp(path, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), "");
    }
    const asset = await fetchApp("/assets/app.js");
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("content-type")!, /javascript/);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=3600");
    assert.equal(asset.headers.get("x-content-type-options"), "nosniff");
    assert.match(await asset.text(), /console.log/);
    for (const path of ["/api/unknown", "/api/canvases/missing", "/package.json", "/%2e%2e%2fpackage.json", "/assets/missing.js"]) {
      const response = await fetchApp(path);
      assert.equal(response.status, 404, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-type")!, /application\/json/);
    }
    assert.equal((await fetchApp("/", { method: "POST" })).status, 405);
  } finally {
    repository.close();
    rmSync(webDirectory, { recursive: true, force: true });
  }
});

test("Hono bounds fixed-size and streamed request bodies", async () => {
  const webDirectory = createWebFixture();
  const repository = new SqliteCanvasRepository(":memory:");
  const app = createApp(new CanvasService(repository), webDirectory, 3000);
  const headers = { host: "localhost", "content-type": "application/json" };
  try {
    const smallStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"title":"Streamed canvas"}'));
        controller.close();
      },
    });
    const accepted = await app.request(new Request("http://localhost/api/canvases", {
      method: "POST", headers, body: smallStream, duplex: "half",
    } as RequestInit));
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json() as CanvasDocument).title, "Streamed canvas");
    const fixed = await app.request("http://localhost/api/canvases", {
      method: "POST", headers: { ...headers, "content-length": String(25 * 1024 * 1024) }, body: "{}",
    });
    assert.equal(fixed.status, 413);
    assert.deepEqual(await fixed.json(), { error: "Request exceeds 24 MiB" });
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunks++ < 25) controller.enqueue(new Uint8Array(1024 * 1024));
        else controller.close();
      },
    });
    const streamed = await app.request(new Request("http://localhost/api/canvases", {
      method: "POST", headers, body: stream, duplex: "half",
    } as RequestInit));
    assert.equal(streamed.status, 413);
    assert.deepEqual(await streamed.json(), { error: "Request exceeds 24 MiB" });
  } finally {
    repository.close();
    rmSync(webDirectory, { recursive: true, force: true });
  }
});
