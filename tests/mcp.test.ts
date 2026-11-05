import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { createAdaptorServer } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { imageSize } from "image-size";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createApp } from "../src/server/http/app.js";
import { CanvasService } from "../src/server/canvas/service.js";
import { DrawingService } from "../src/server/canvas/drawing.js";
import { HeadlessService } from "../src/server/render/client.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import { developmentContext } from "../src/server/auth/context.js";
import { resolveCanvasId } from "../src/server/mcp/canvas-reference.js";
import type { Scene } from "../src/shared/canvas.js";

test("official HTTP MCP client: drawing toolkit, isolation, atomicity, rendering and reconnect", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const app = createApp(service, "dist/web", 3000);
  const http = createAdaptorServer({ fetch: app.fetch });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const address = http.address();
  assert(address && typeof address !== "string");
  const endpoint = new URL(`http://127.0.0.1:${address.port}/mcp`);
  let client = new Client({ name: "integration", version: "1" });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name, arguments: args });
    assert(!response.isError, JSON.stringify(response));
    return response.structuredContent as Record<string, any>;
  };
  try {
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    assert.equal((await client.listTools()).tools.length, 31);
    const first = await call("create_canvas", { title: "Agent diagram" });
    const second = await call("create_canvas", { title: "Isolated" });
    const canvasId = first.canvasId as string;
    const published: number[] = [];
    const unsubscribe = service.subscribe(developmentContext, canvasId, update => published.push(update.revision));
    assert.equal(resolveCanvasId(first.url, "http://127.0.0.1:3000"), canvasId);
    assert.throws(() => resolveCanvasId(`https://evil.test/canvases/${canvasId}`, "http://127.0.0.1:3000"));
    await call("batch_create_elements", { canvasId: first.url, elements: [
      { id: "a", type: "rectangle", x: 0, y: 0, width: 180, height: 80, text: "First" },
      { id: "b", type: "ellipse", x: 400, y: 100, width: 180, height: 80, text: "Second" },
      { id: "c", type: "diamond", x: 800, y: 200, width: 180, height: 80 },
      { id: "arrow", type: "arrow", x: 180, y: 40, startElementId: "a", endElementId: "b" },
    ] });
    const get = () => service.get(developmentContext, canvasId);
    const element = (id: string) => get().scene.elements.find(e => e.id === id)!;
    const label = get().scene.elements.find(e => e.containerId === "a")!;
    assert.equal(label.text, "First");
    assert.equal((element("arrow").startBinding as any).elementId, "a");
    assert(Number(element("arrow").width) > 150);
    await call("update_element", { canvasId, id: "a", x: 50, text: "Changed" });
    assert.equal(element(label.id).originalText, "Changed");
    await call("update_element", { canvasId, id: label.id, text: "Direct label" });
    assert.equal(element(label.id).text, "Direct label");
    await call("update_element", { canvasId, id: label.id, fontFamily: "mono" });
    assert.equal(element(label.id).fontFamily, 3);
    const revision = get().revision;
    assert.equal(published.at(-1), revision);
    const broadcasts = published.length;
    const bad = await client.callTool({ name: "batch_mutate_elements", arguments: { canvasId, operations: [
      { op: "update", id: "a", changes: { x: 999 } }, { op: "delete", id: "missing" },
    ] } });
    assert(bad.isError);
    assert.equal(get().revision, revision);
    assert.equal(published.length, broadcasts);
    const stale = await client.callTool({ name: "update_element", arguments: { canvasId, id: "a", x: 999, expectedRevision: 0 } });
    assert(stale.isError);
    assert.equal((stale.structuredContent as any).error.status, 409);
    const group = await call("group_elements", { canvasId, elementIds: ["a", "b"] });
    assert((element(label.id).groupIds as string[]).includes(group.groupId));
    await call("lock_elements", { canvasId, elementIds: ["a"] });
    assert.equal(element(label.id).locked, true);
    await call("align_elements", { canvasId, elementIds: ["a", "b", "c"], alignment: "top" });
    assert.equal(element("a").y, element("b").y);
    assert.equal(element(label.id).locked, true);
    await call("distribute_elements", { canvasId, elementIds: ["a", "b", "c"], direction: "horizontal" });
    await call("create_element", { canvasId, id: "negative-line", type: "line", x: 200, y: 300, points: [[0, 0], [-100, 100]], roughness: 0 });
    const described = await call("describe_scene", { canvasId });
    assert.equal(described.elements.find((e: any) => e.id === "negative-line").bounds.x, 100);
    await call("align_elements", { canvasId, elementIds: ["a", "negative-line"], alignment: "left" });
    const aligned = await call("describe_scene", { canvasId });
    assert.equal(aligned.elements.find((e: any) => e.id === "negative-line").bounds.x, Number(element("a").x));
    await call("unlock_elements", { canvasId, elementIds: ["a"] });
    await call("ungroup_elements", { canvasId, groupId: group.groupId });
    const duplicate = await call("duplicate_elements", { canvasId, elementIds: ["a", "b", "arrow"] });
    assert.equal((element(duplicate.idMap.arrow).startBinding as any).elementId, duplicate.idMap.a);
    assert.equal(element(duplicate.idMap[label.id]).containerId, duplicate.idMap.a);
    assert((await call("query_elements", { canvasId, text: "Direct label" })).total >= 1);
    assert((await call("describe_scene", { canvasId })).connections.length >= 2);
    assert((await call("get_element", { canvasId, id: "a" })).element);
    assert((await call("get_resource", { canvasId, resource: "scene" })).resource.files);
    assert((await call("read_diagram_guide")).guide);
    const png = await client.callTool({ name: "get_canvas_screenshot", arguments: { canvasId, elementIds: ["a"], scale: 2 } });
    assert(!png.isError, JSON.stringify(png));
    const image = png.content.find(item => item.type === "image");
    assert(image && image.type === "image");
    const size = imageSize(Buffer.from(image.data, "base64"));
    assert.equal(size.width, (png.structuredContent as any).width);
    const svg = await client.callTool({ name: "export_to_image", arguments: { canvasId, format: "svg", elementIds: ["a"] } });
    assert(!svg.isError);
    const resource = svg.content.find(item => item.type === "resource");
    assert(resource?.type === "resource" && "text" in resource.resource);
    assert.match(resource.resource.text, /data:font\/woff2;base64/);
    const exported = await call("export_scene", { canvasId });
    await call("import_scene", { canvasId: second.canvasId, scene: { ...exported.scene, appState: { ...exported.scene.appState, scrollX: 123 } }, mode: "replace", expectedRevision: 0 });
    await call("delete_element", { canvasId, id: "a" });
    assert(element(label.id).isDeleted);
    assert.equal(element("arrow").startBinding, null);
    assert(!service.get(developmentContext, second.canvasId).scene.elements.find(e => e.id === "a")!.isDeleted);
    await call("create_element", { canvasId, id: "single", type: "text", x: 0, y: 0, text: "Standalone" });
    await call("apply_mutations", { canvasId, elements: [], sharedSettings: { viewBackgroundColor: "#fafafa" } });
    await call("clear_canvas", { canvasId });
    assert(get().scene.elements.every(e => e.isDeleted));
    await client.close();
    client = new Client({ name: "reconnected", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(endpoint));
    assert.equal((await call("list_canvases")).canvases.length, 2);
    assert.equal((await call("get_canvas", { canvasId: second.url })).canvasId, second.canvasId);
    unsubscribe();
  } finally {
    await client.close();
    await app.closeMcp();
    await new Promise<void>(resolve => http.close(() => resolve()));
    repository.close();
  }
});

test("async normalization rejects concurrent edits and cancellation without a partial commit", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const service = new CanvasService(repository);
  const headless = new HeadlessService();
  const drawing = new DrawingService(service, headless);
  const canvas = service.create(developmentContext, { title: "Concurrency" });
  try {
    const pending = drawing.edit(developmentContext, canvas.id, [{ op: "create", element: { id: "late", type: "rectangle", x: 0, y: 0 } }]);
    service.mutate(developmentContext, canvas.id, { elements: [], sharedSettings: { viewBackgroundColor: "#123456" } });
    await assert.rejects(pending, (error: any) => error.status === 409);
    assert.equal(service.get(developmentContext, canvas.id).scene.elements.length, 0);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(drawing.edit(developmentContext, canvas.id, [{ op: "create", element: { id: "cancelled", type: "rectangle", x: 0, y: 0 } }], undefined, controller.signal));
    assert.equal(service.get(developmentContext, canvas.id).scene.elements.length, 0);
  } finally { await headless.close(); repository.close(); }
});

test("headless rejects oversized output", async () => {
  const headless = new HeadlessService();
  try {
    const elements = await headless.convert([{ id: "huge", type: "rectangle", x: 0, y: 0, width: 5000, height: 100 }]);
    const scene: Scene = { elements, files: {}, sharedSettings: { viewBackgroundColor: "#ffffff" } };
    await assert.rejects(headless.render({ scene, format: "png", scale: 1, padding: 10, background: true, dark: false }), /4096px/);
  } finally { await headless.close(); }
});

test("headless renders stored raster pixels and refuses missing raster data", async () => {
  const headless = new HeadlessService();
  try {
    const source = createCanvas(20, 20);
    source.getContext("2d").fillStyle = "#ff0000";
    source.getContext("2d").fillRect(0, 0, 20, 20);
    const elements = await headless.convert([{ id: "image", type: "image", x: 0, y: 0, width: 100, height: 100, fileId: "raster" }]);
    const scene: Scene = { elements, files: { raster: { id: "raster", created: 0, mimeType: "image/png", dataURL: source.toDataURL("image/png") } }, sharedSettings: { viewBackgroundColor: "#ffffff" } };
    const output = await headless.render({ scene, format: "png", scale: 1, padding: 10, background: true, dark: false });
    const canvas = createCanvas(120, 120);
    canvas.getContext("2d").drawImage(await loadImage(Buffer.from(output.data, "base64")), 0, 0);
    assert.deepEqual([...canvas.getContext("2d").getImageData(60, 60, 1, 1).data], [255, 0, 0, 255]);
    await assert.rejects(headless.render({ scene: { ...scene, files: {} }, format: "png", scale: 1, padding: 10, background: true, dark: false }), /missing/);
  } finally { await headless.close(); }
});
