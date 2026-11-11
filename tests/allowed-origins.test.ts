import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket } from "ws";
import type { Authentication } from "../src/server/auth/propelauth.js";
import { developmentContext } from "../src/server/auth/context.js";
import { ServiceError } from "../src/server/canvas/errors.js";
import { CanvasService } from "../src/server/canvas/service.js";
import { createApp } from "../src/server/http/app.js";
import { localRequestPolicy } from "../src/server/http/local-request.js";
import { createLiveServer } from "../src/server/live/server.js";
import { canvasUrl, resolveCanvasId } from "../src/server/mcp/canvas-reference.js";
import { createTestRepository } from "./postgres.js";

const publicUrl = "https://tunnel.ngrok-free.app";
const allowedOrigins = ["http://localhost:53080", publicUrl];

test("explicit aliases accept local and tunnel browser requests without relaxing host/origin checks", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const principal = { userId: "alice", organizations: [{ id: "org-a", name: "A" }] };
  const authentication: Authentication = {
    authUrl: "https://auth.example",
    getPrincipal: async () => principal,
    authenticate: async header => {
      if (header !== "Bearer browser") throw new ServiceError(401, "Login required");
      return principal;
    },
  };
  const normal = createApp(service, "dist/web", 3000, publicUrl);
  const apps = [false, true].map(authenticated => createApp(service, "dist/web", 3000, publicUrl, { allowedOrigins }, authenticated ? authentication : undefined));
  try {
    assert.equal((await normal.request(`${publicUrl}/health/live`, { headers: { host: new URL(publicUrl).host } })).status, 403);
    for (const app of apps) {
      const request = (host: string, headers: Record<string, string> = {}, path = "/health/live") => app.request(`http://localhost${path}`, { headers: { host, ...headers } });
      for (const origin of allowedOrigins) {
        const response = await request(new URL(origin).host, { origin });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("access-control-allow-origin"), null);
      }
      for (const host of ["evil.example", "tunnel.ngrok-free.app.evil.example", "tunnel.ngrok-free.app:9999", "user@tunnel.ngrok-free.app"]) {
        assert.equal((await request(host)).status, 403);
      }
      for (const origin of ["https://evil.example", "https://tunnel.ngrok-free.app:9999", "http://tunnel.ngrok-free.app", "http://localhost:53081", "null"]) {
        assert.equal((await request("tunnel.ngrok-free.app", { origin })).status, 403);
      }
      assert.equal((await request("tunnel.ngrok-free.app", { origin: publicUrl, "sec-fetch-site": "cross-site" })).status, 403);
      assert.equal((await request("evil.example", { "x-forwarded-host": "tunnel.ngrok-free.app" })).status, 403);
    }
    const authenticated = apps[1]!;
    for (const origin of allowedOrigins) {
      const headers = { host: new URL(origin).host, origin };
      assert.equal((await authenticated.request(`${origin}/api/auth/me`, { headers })).status, 401);
      assert.equal((await authenticated.request(`${origin}/api/auth/me`, { headers: { ...headers, authorization: "Bearer browser" } })).status, 200);
    }
    const id = (await service.create(developmentContext, { title: "Aliases" })).id;
    const policy = localRequestPolicy(3000, false, [], publicUrl, allowedOrigins);
    assert.equal(resolveCanvasId(`http://localhost:53080/canvases/${id}`, publicUrl, policy.origins), id);
    assert.throws(() => resolveCanvasId(`https://evil.example/canvases/${id}`, publicUrl, policy.origins));
    assert.equal(canvasUrl(id, publicUrl), `${publicUrl}/canvases/${id}`);
  } finally {
    await Promise.all([normal, ...apps].map(app => app.closeMcp()));
    await repository.close();
  }
});

test("local and tunnel aliases support development WebSocket upgrades", async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000, publicUrl, { allowedOrigins });
  const live = createLiveServer();
  const server = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const id = (await service.create(developmentContext, { title: "Tunnel" })).id;
  const endpoint = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/api/canvases/${id}/live`;
  const sockets: WebSocket[] = [];
  try {
    for (const origin of allowedOrigins) {
      const socket = new WebSocket(endpoint, { headers: { host: new URL(origin).host }, origin });
      sockets.push(socket);
      const [data] = await once(socket, "message");
      assert.equal(JSON.parse(data.toString()).type, "snapshot");
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const socket = new WebSocket(endpoint, { headers: { host: "tunnel.ngrok-free.app" }, origin: "https://evil.example" });
      socket.on("error", () => {});
      socket.on("unexpected-response", (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode); });
      socket.on("open", () => { socket.terminate(); reject(new Error("Unexpected upgrade")); });
    });
    assert.equal(status, 403);
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.closeMcp();
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await repository.close();
  }
});
