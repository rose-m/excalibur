import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { WebSocket } from "ws";
import { z } from "zod";
import { CanvasService } from "../src/server/canvas/service.js";
import { developmentContext as context } from "../src/server/auth/context.js";
import { createApp } from "../src/server/http/app.js";
import { createLiveServer } from "../src/server/live/server.js";
import { createTestRepository } from "./postgres.js";
import type { CanvasComment } from "../src/shared/comments.js";

type Reply = { canvasId: string; url: string; commentsRevision: number; comments: CanvasComment[]; commentId?: string };

test("MCP comment tools retrieve, add and resolve through the shared live comment service", { timeout: 15_000 }, async () => {
  const repository = await createTestRepository();
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000);
  const live = createLiveServer();
  const http = createAdaptorServer({ fetch: app.fetch, websocket: live.adapter });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  let client = new Client({ name: "comment-tools", version: "1" });
  let socket: WebSocket | undefined;
  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, JSON.stringify(response));
    return response.structuredContent as Reply;
  };
  try {
    const canvas = await service.create(context, { title: "Agent notes" });
    const other = await service.create(context, { title: "Other canvas" });
    const privateCanvas = await service.create({ ...context, userId: "another owner" }, { title: "Not accessible" });
    await service.mutate(context, canvas.id, { elements: [{ id: "box", type: "rectangle", x: 0, y: 0, width: 200, height: 100, version: 1, versionNonce: 1, isDeleted: false }] });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find(tool => tool.name === "get_comments")?.annotations?.readOnlyHint, true);
    assert.equal(tools.find(tool => tool.name === "resolve_comment")?.annotations?.destructiveHint, true);
    const empty = await call("get_comments", { canvasId: canvas.id });
    assert.deepEqual(empty.comments, []);
    assert.equal(empty.commentsRevision, 0);
    assert(!Object.hasOwn(empty, "revision"), "do not confuse comment revisions with drawing revisions");
    socket = new WebSocket(`${base.replace("http:", "ws:")}/api/canvases/${canvas.id}/live`, { origin: "http://localhost:3000" });
    await once(socket, "message");
    const broadcast = once(socket, "message");
    const added = await call("add_comment", { canvasId: `http://127.0.0.1:3000/canvases/${canvas.id}`, text: "  Please review this.  ", anchor: { type: "canvas", x: 30, y: 40 } });
    assert(z.uuid().safeParse(added.commentId).success);
    assert.equal(added.comments[0]!.text, "Please review this.");
    assert.equal(added.commentsRevision, 1);
    const [data] = await broadcast;
    assert.deepEqual(JSON.parse(data.toString()), { type: "comments", state: { revision: 1, comments: added.comments } });
    assert.equal((await service.get(context, canvas.id)).revision, 1);
    assert.equal((await call("get_comments", { canvasId: other.id })).comments.length, 0);

    const commentId = randomUUID();
    const anchor = { type: "element", elementId: "box", u: 0.5, v: 0.25, x: 100, y: 25 };
    const attached = await call("add_comment", { canvasId: canvas.id, commentId, text: "Attached note", anchor });
    assert.equal(attached.commentId, commentId);
    assert.equal(attached.commentsRevision, 2);
    assert.deepEqual(attached.comments.find(comment => comment.id === commentId)?.anchor, anchor);
    const retry = await call("add_comment", { canvasId: canvas.id, commentId, text: "Attached note", anchor });
    assert.equal(retry.commentsRevision, 2);
    assert.equal(retry.comments.length, 2);
    assert.equal((await service.get(context, canvas.id)).revision, 1);

    for (const [name, args, status] of [
      ["add_comment", { canvasId: canvas.id, commentId, text: "Changed content", anchor }, 409],
      ["add_comment", { canvasId: canvas.id, text: "Missing target", anchor: { ...anchor, elementId: "missing" } }, 409],
      ["get_comments", { canvasId: "https://evil.test/canvases/" + canvas.id }, 400],
      ["get_comments", { canvasId: privateCanvas.id }, 404],
      ["add_comment", { canvasId: privateCanvas.id, text: "Forbidden", anchor: { type: "canvas", x: 0, y: 0 } }, 404],
      ["resolve_comment", { canvasId: privateCanvas.id, commentId }, 404],
    ] as const) {
      const response = await client.callTool({ name, arguments: args });
      assert(response.isError, JSON.stringify(response));
      assert.equal((response.structuredContent as { error: { status: number } }).error.status, status);
    }
    for (const args of [
      { canvasId: canvas.id, text: " ", anchor },
      { canvasId: canvas.id, text: "x".repeat(4001), anchor },
      { canvasId: canvas.id, text: "Invalid anchor", anchor: { ...anchor, u: 2 } },
      { canvasId: canvas.id, text: "Spoofing", anchor, userId: "another owner" },
    ]) assert((await client.callTool({ name: "add_comment", arguments: args })).isError);
    assert.equal((await call("get_comments", { canvasId: canvas.id })).commentsRevision, 2);

    await call("resolve_comment", { canvasId: other.id, commentId });
    assert.equal((await call("get_comments", { canvasId: canvas.id })).comments.length, 2);
    await client.close();
    client = new Client({ name: "reconnected-comment-tools", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    assert.equal((await call("get_comments", { canvasId: canvas.id })).comments.length, 2);
    const resolved = await call("resolve_comment", { canvasId: canvas.id, commentId });
    assert.equal(resolved.commentsRevision, 3);
    assert.deepEqual(resolved.comments.map(comment => comment.id), [added.commentId]);
    assert.equal((await call("resolve_comment", { canvasId: canvas.id, commentId })).commentsRevision, 3);
    const last = await call("resolve_comment", { canvasId: canvas.id, commentId: added.commentId });
    assert.equal(last.commentsRevision, 4);
    assert.deepEqual(last.comments, []);
    assert.equal((await service.get(context, canvas.id)).revision, 1);
  } finally {
    await client.close();
    socket?.terminate();
    await app.closeMcp();
    await new Promise<void>(resolve => live.sockets.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
    await repository.close();
  }
});
