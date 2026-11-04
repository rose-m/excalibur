import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { createAdaptorServer } from "@hono/node-server";
import { WebSocket } from "ws";
import { CanvasService } from "../src/server/canvas/service.js";
import { developmentContext } from "../src/server/auth/context.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { ServerMessage } from "../src/shared/live.js";

class Inbox {
  messages: ServerMessage[] = [];
  private wake = () => {};
  constructor(public socket: WebSocket) {
    socket.on("error", () => {});
    socket.on("message", (data) => {
      this.messages.push(JSON.parse(data.toString()) as ServerMessage);
      this.wake();
    });
  }
  async next(type: ServerMessage["type"]): Promise<ServerMessage> {
    const timeout = setTimeout(() => { this.wake(); }, 3000);
    const deadline = Date.now() + 3000;
    try {
      while (true) {
        const index = this.messages.findIndex((message) => message.type === type);
        if (index >= 0) return this.messages.splice(index, 1)[0]!;
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${type}`);
        await new Promise<void>((resolve) => { this.wake = resolve; });
      }
    } finally { clearTimeout(timeout); }
  }
  mutate(elements: unknown[], expectedRevision?: number) {
    this.socket.send(JSON.stringify({ type: "mutate", requestId: randomUUID(), mutation: {
      elements, ...(expectedRevision === undefined ? {} : { expectedRevision }),
    } }));
  }
}

test("two WebSocket clients and service edits share committed canvas rooms; joins/reconnects resync", { timeout: 15_000 }, async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000);
  const live = createLiveServer();
  const server = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const clients: Inbox[] = [];
  function connect(id: string) {
    const client = new Inbox(new WebSocket(`${base}/api/canvases/${id}/live`, { origin: "http://localhost:3000" }));
    clients.push(client);
    return client;
  }
  const element = (id: string, index: string, version = 1, versionNonce = 1) => ({ id, index, type: "rectangle", version, versionNonce, isDeleted: false });
  try {
    const canvas = service.create(developmentContext, { title: "Shared" });
    async function rejected(id: string, origin?: string) {
      return new Promise<number>((resolve, reject) => {
        const socket = new WebSocket(`${base}/api/canvases/${id}/live`, origin ? { origin } : {});
        socket.on("unexpected-response", (_req, response) => {
          response.resume();
          socket.terminate();
          resolve(response.statusCode!);
        });
        socket.on("open", () => { socket.terminate(); reject(new Error("Unexpected WebSocket upgrade")); });
        socket.on("error", () => {});
      });
    }
    assert.equal(await rejected(canvas.id), 403);
    assert.equal(await rejected(canvas.id, "https://unrelated.example"), 403);
    assert.equal(await rejected(randomUUID(), "http://localhost:3000"), 404);
    const isolated = service.create(developmentContext, { title: "Isolated" });
    const a = connect(canvas.id);
    const b = connect(canvas.id);
    const other = connect(isolated.id);
    await Promise.all([a.next("snapshot"), b.next("snapshot"), other.next("snapshot")]);
    a.socket.send("not JSON");
    const invalid = await a.next("error");
    assert.equal(invalid.type === "error" && invalid.status, 400);
    a.socket.send(Buffer.from("{}"));
    const binary = await a.next("error");
    assert.equal(binary.type === "error" && binary.status, 400);
    assert.equal(service.get(developmentContext, canvas.id).revision, 0);
    a.mutate([element("a", "a0")]);
    const ack = await a.next("ack");
    assert.equal(ack.type === "ack" && ack.update.revision, 1);
    const received = await b.next("update");
    assert.equal(received.type === "update" && received.update.elements[0]?.id, "a");
    assert.equal(service.get(developmentContext, canvas.id).revision, 1);
    b.mutate([element("b", "a1")]);
    await b.next("ack");
    assert.equal(service.get(developmentContext, canvas.id).scene.elements.length, 2);
    assert.deepEqual(other.messages, [], "canvas rooms must not leak updates");

    a.mutate([{ ...element("a", "a0", 2, 90), width: 90 }]);
    b.mutate([{ ...element("a", "a0", 2, 10), width: 10 }]);
    await Promise.all([a.next("ack"), b.next("ack")]);
    assert.equal(service.get(developmentContext, canvas.id).scene.elements[0]?.width, 10);
    const revision = service.get(developmentContext, canvas.id).revision;
    a.mutate([element("stale", "a2")], 0);
    const conflict = await a.next("error");
    assert.equal(conflict.type === "error" && conflict.status, 409);
    assert.equal(service.get(developmentContext, canvas.id).revision, revision);

    a.socket.close();
    await once(a.socket, "close");
    service.mutate(developmentContext, canvas.id, { elements: [element("agent", "a2")] });
    const reconnected = connect(canvas.id);
    const snapshot = await reconnected.next("snapshot");
    assert.equal(snapshot.type === "snapshot" && snapshot.canvas.revision, revision + 1);
    assert.ok(snapshot.type === "snapshot" && snapshot.canvas.scene.elements.some((item) => item.id === "agent"));
    const response = await fetch(base.replace("ws:", "http:") + `/api/canvases/${canvas.id}/mutations`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ elements: [element("http-agent", "a3")], expectedRevision: revision + 1 }),
    });
    assert.equal(response.status, 200);
    const httpUpdate = await reconnected.next("update");
    assert.ok(httpUpdate.type === "update" && httpUpdate.update.elements.some((item) => item.id === "http-agent"));
  } finally {
    for (const client of clients) client.socket.terminate();
    await new Promise<void>((resolve) => live.sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    repository.close();
  }
});
