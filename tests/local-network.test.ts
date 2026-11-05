import assert from "node:assert/strict";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket } from "ws";
import { z } from "zod";
import { devEnvironment } from "../scripts/dev.js";
import { isLocalAddress, localAddresses } from "../src/server/local-network.js";
import { localRequestPolicy } from "../src/server/http/local-request.js";
import { createApp } from "../src/server/http/app.js";
import { CanvasService } from "../src/server/canvas/service.js";
import { developmentContext } from "../src/server/auth/context.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import { createLiveServer } from "../src/server/live/server.js";
import { resolveCanvasId } from "../src/server/mcp/canvas-reference.js";
import { requestId } from "../src/web/request-id.js";

test("LAN discovery includes private interface addresses, not public or loopback addresses", () => {
  for (const address of ["10.0.0.1", "172.16.0.1", "172.31.255.254", "192.168.1.10", "169.254.1.2"]) assert(isLocalAddress(address));
  for (const address of ["127.0.0.1", "0.0.0.0", "172.15.0.1", "172.32.0.1", "8.8.8.8", "192.169.1.1", "example.com", "::1"]) assert(!isLocalAddress(address));
  const entry = (address: string, internal = false) => ({ address, internal, family: "IPv4" as const, netmask: "255.255.255.0", mac: "00:00:00:00:00:00", cidr: `${address}/24` });
  assert.deepEqual(localAddresses({ lo: [entry("127.0.0.1", true)], en0: [entry("192.168.1.10")], duplicate: [entry("192.168.1.10")], public: [entry("8.8.8.8")] }), ["192.168.1.10"]);
});

test("dev --allow-local is explicit, configures both servers, and accepts pnpm's separator", () => {
  const addresses = ["192.168.1.10"];
  const normal = devEnvironment([], {}, addresses);
  assert.equal(normal.EXCALIBUR_ALLOW_LOCAL, "0");
  assert.equal(normal.PUBLIC_URL, "http://127.0.0.1:5173");
  for (const args of [["--allow-local"], ["--", "--allow-local"]]) {
    const env = devEnvironment(args, {}, addresses);
    assert.equal(env.EXCALIBUR_ALLOW_LOCAL, "1");
    assert.equal(env.PUBLIC_URL, "http://192.168.1.10:5173");
  }
  assert.equal(devEnvironment(["--allow-local"], { PUBLIC_URL: "http://localhost:5173" }, addresses).PUBLIC_URL, "http://localhost:5173");
  assert.equal(devEnvironment(["--allow-local"], {}, []).PUBLIC_URL, "http://127.0.0.1:5173");
  assert.throws(() => devEnvironment(["--allow-lcoal"], {}, addresses));
});

test("backend and Vite bind to all interfaces only with the shared LAN opt-in", () => {
  for (const enabled of [false, true]) {
    const env = devEnvironment(enabled ? ["--allow-local"] : [], { ...process.env, HOST: "127.0.0.1", PORT: "3000", PUBLIC_URL: "http://127.0.0.1:5173" }, ["192.168.1.10"]);
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { config } from './src/server/config.ts';
      import vite from './vite.config.ts';
      console.log(JSON.stringify({ server: config.host, vite: vite.server.host, allowLocal: config.allowLocal }));
    `], { env, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { server: enabled ? "0.0.0.0" : "127.0.0.1", vite: enabled ? "0.0.0.0" : "127.0.0.1", allowLocal: enabled });
  }
});

test("LAN opt-in allows only this host's local IPs and exact origins, preserving cross-site safeguards", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const normal = createApp(service, "dist/web", 3000);
  const lan = createApp(service, "dist/web", 3000, "http://192.168.1.10:5173", { allowLocal: true, localAddresses: ["192.168.1.10", "8.8.8.8"] });
  const get = (app: typeof normal, host: string, headers: Record<string, string> = {}) => app.request("http://localhost/api/canvases", { headers: { host, ...headers } });
  try {
    assert.equal((await get(normal, "192.168.1.10:5173")).status, 403);
    assert.equal((await get(lan, "192.168.1.10:5173", { origin: "http://192.168.1.10:5173" })).status, 200);
    assert.equal((await get(lan, "192.168.1.10:3000", { origin: "http://192.168.1.10:3000" })).status, 200);
    assert.equal((await get(lan, "localhost:3000", { origin: "http://127.0.0.1:5173" })).status, 200);
    for (const host of ["192.168.1.11", "8.8.8.8", "evil.test", "192.168.1.10.evil.test", "[invalid", "evil@192.168.1.10"]) assert.equal((await get(lan, host)).status, 403);
    for (const origin of ["http://192.168.1.11:5173", "http://192.168.1.10:9999", "https://evil.test", "null"]) assert.equal((await get(lan, "192.168.1.10:3000", { origin })).status, 403);
    assert.equal((await get(lan, "192.168.1.10:5173", { origin: "http://192.168.1.10:5173", "sec-fetch-site": "cross-site" })).status, 403);
    const id = service.create(developmentContext, { title: "LAN reference" }).id;
    const policy = localRequestPolicy(3000, true, ["192.168.1.10"]);
    assert.equal(resolveCanvasId(`http://192.168.1.10:5173/canvases/${id}`, "http://localhost:5173", policy.origins), id);
    assert.throws(() => resolveCanvasId(`http://192.168.1.11:5173/canvases/${id}`, "http://localhost:5173", policy.origins));
    assert.throws(() => resolveCanvasId(`http://192.168.1.10:5173/canvases/${id}`, "http://localhost:5173"));
  } finally { await normal.closeMcp(); await lan.closeMcp(); repository.close(); }
});

test("LAN browser WebSockets accept the allowed origin but still reject unrelated LAN origins", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000, "http://192.168.1.10:5173", { allowLocal: true, localAddresses: ["192.168.1.10"] });
  const live = createLiveServer();
  const server = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const id = service.create(developmentContext, { title: "iPad" }).id;
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/canvases/${id}/live`;
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(endpoint, { headers: { host: "192.168.1.10:5173" }, origin: "http://192.168.1.10:5173" });
    const [data] = await once(socket, "message");
    assert.equal(JSON.parse(data.toString()).type, "snapshot");
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const rejected = new WebSocket(endpoint, { headers: { host: "192.168.1.10:5173" }, origin: "http://192.168.1.11:5173" });
      rejected.on("error", () => {});
      rejected.on("unexpected-response", (_request, response) => { response.resume(); rejected.terminate(); resolve(response.statusCode); });
      rejected.on("open", () => { rejected.terminate(); reject(new Error("Unexpected upgrade")); });
    });
    assert.equal(status, 403);
  } finally {
    socket?.terminate();
    await app.closeMcp();
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    repository.close();
  }
});

test("mutation request IDs remain valid on insecure LAN HTTP where crypto.randomUUID is missing", () => {
  const source: Pick<Crypto, "getRandomValues"> = { getRandomValues: array => crypto.getRandomValues(array) };
  const a = requestId(source), b = requestId(source);
  assert(z.uuid().safeParse(a).success);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(a, b);
});
