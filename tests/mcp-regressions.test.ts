import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { imageSize } from "image-size";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { CanvasService } from "../src/server/canvas/service.js";
import { DrawingService } from "../src/server/canvas/drawing.js";
import { developmentContext as context } from "../src/server/auth/context.js";
import { HeadlessService } from "../src/server/render/client.js";
import { SqliteCanvasRepository } from "../src/server/persistence/sqlite.js";
import type { Scene } from "../src/shared/canvas.js";

test("moving and resizing shapes retain native routed arrows and binding metadata", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const canvases = new CanvasService(repository);
  const headless = new HeadlessService();
  const drawing = new DrawingService(canvases, headless);
  const canvas = canvases.create(context, { title: "Routed" });
  try {
    await drawing.edit(context, canvas.id, [
      { op: "create", element: { id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 100 } },
      { op: "create", element: { id: "b", type: "rectangle", x: 400, y: 200, width: 100, height: 100 } },
      { op: "create", element: { id: "route", type: "arrow", x: 110, y: 50, points: [[0, 0], [80, 0], [80, 200], [280, 200]], startElementId: "a", endElementId: "b", text: "Keep bends" } },
    ]);
    const original = canvases.get(context, canvas.id).scene.elements.find(e => e.id === "route")!;
    await drawing.edit(context, canvas.id, [{ op: "update", id: "a", changes: { x: -50, height: 150 } }]);
    const updated = canvases.get(context, canvas.id).scene.elements.find(e => e.id === "route")!;
    assert.equal((updated.points as number[][]).length, 4);
    for (const i of [1, 2]) {
      const a = (original.points as number[][])[i]!, b = (updated.points as number[][])[i]!;
      assert(Math.abs(Number(original.x) + a[0]! - Number(updated.x) - b[0]!) < 0.001);
      assert(Math.abs(Number(original.y) + a[1]! - Number(updated.y) - b[1]!) < 0.001);
    }
    assert.deepEqual(updated.startBinding, original.startBinding);
    assert.deepEqual(updated.endBinding, original.endBinding);
    assert.notEqual(updated.x, original.x);
  } finally { await headless.close(); repository.close(); }
});

test("native frames move with children and resize without skeleton conversion", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const canvases = new CanvasService(repository);
  const headless = new HeadlessService();
  const drawing = new DrawingService(canvases, headless);
  const canvas = canvases.create(context, { title: "Frames" });
  try {
    const elements = await headless.convert([
      { id: "frame", type: "frame", x: 10, y: 20, width: 200, height: 100, name: "Frame", children: ["child"] },
      { id: "child", type: "rectangle", x: 30, y: 40, width: 50, height: 50 },
    ]);
    canvases.mutate(context, canvas.id, { elements });
    await drawing.edit(context, canvas.id, [{ op: "update", id: "frame", changes: { x: 110, y: 120, width: 300 } }]);
    const scene = canvases.get(context, canvas.id).scene;
    const frame = scene.elements.find(e => e.id === "frame")!, child = scene.elements.find(e => e.id === "child")!;
    assert.deepEqual([frame.x, frame.y, frame.width, frame.name], [110, 120, 300, "Frame"]);
    assert.deepEqual([child.x, child.y, child.width, child.frameId], [130, 140, 50, "frame"]);
    assert(!Object.hasOwn(frame, "children"));
  } finally { await headless.close(); repository.close(); }
});

test("linear points and dimensions stay consistent through creation and resizing", async () => {
  const repository = new SqliteCanvasRepository(":memory:");
  const canvases = new CanvasService(repository);
  const headless = new HeadlessService();
  const drawing = new DrawingService(canvases, headless);
  const canvas = canvases.create(context, { title: "Lines" });
  try {
    await drawing.edit(context, canvas.id, [
      { op: "create", element: { id: "line", type: "line", x: 200, y: 0, points: [[0, 0], [-50, 30], [-100, 100]] } },
      { op: "create", element: { id: "arrow", type: "arrow", x: 0, y: 0, width: 100, height: 50 } },
    ]);
    const read = (id: string) => canvases.get(context, canvas.id).scene.elements.find(e => e.id === id)!;
    assert.equal(read("line").height, 100);
    await drawing.edit(context, canvas.id, [
      { op: "update", id: "line", changes: { width: 500, height: 200 } },
      { op: "update", id: "arrow", changes: { width: 500, height: 200 } },
    ]);
    assert.deepEqual(read("line").points, [[0, 0], [-250, 60], [-500, 200]]);
    assert.deepEqual(read("arrow").points, [[0, 0], [500, 200]]);
    assert.deepEqual([read("arrow").width, read("arrow").height], [500, 200]);
    await drawing.edit(context, canvas.id, [{ op: "update", id: "line", changes: { width: 999, points: [[0, 0], [-30, 40]] } }]);
    assert.deepEqual([read("line").width, read("line").height], [30, 40]);
  } finally { await headless.close(); repository.close(); }
});

test("native geometry bounds handle negative points and rotated linear elements", async () => {
  const headless = new HeadlessService();
  try {
    const elements = await headless.convert([{ id: "line", type: "line", x: 200, y: 0, width: 100, height: 100, points: [[0, 0], [-100, 100]], roughness: 0 }]);
    const bounds = await headless.bounds(elements);
    assert.deepEqual(bounds.line, { x: 100, y: 0, width: 100, height: 100 });
    const rotated = await headless.bounds(elements.map(e => ({ ...e, angle: Math.PI / 2 })));
    assert(Math.abs(rotated.line!.width - 100) < 0.001);
    assert(Math.abs(rotated.line!.x - 100) < 0.001);
  } finally { await headless.close(); }
});

test("frame titles are included in output dimensions and render limits, including fractional scale", async () => {
  const headless = new HeadlessService();
  try {
    const elements = await headless.convert([{ id: "frame", type: "frame", x: 10, y: 10, width: 200, height: 100, name: "A frame", children: [] }]);
    const scene: Scene = { elements, files: {}, sharedSettings: { viewBackgroundColor: "#fff" } };
    for (const scale of [1, 0.33]) {
      const options = { scene, scale, padding: 10, background: true, dark: false };
      const svg = await headless.render({ ...options, format: "svg" });
      const png = await headless.render({ ...options, format: "png" });
      const size = imageSize(Buffer.from(png.data, "base64"));
      assert.equal(png.width, size.width);
      assert.equal(png.height, size.height);
      assert.equal(png.width, Math.ceil(svg.width));
      assert.equal(png.height, Math.ceil(svg.height));
      assert(svg.height > 120 * scale);
      assert.match(svg.data, new RegExp(`height="${svg.height}"`));
    }
    const hugeTitle = { ...scene, elements: elements.map(e => ({ ...e, name: "Line\n".repeat(300) })) };
    for (const format of ["png", "svg"] as const) await assert.rejects(headless.render({ scene: hugeTitle, format, scale: 1, padding: 10, background: true, dark: false }), /4096px/);
  } finally { await headless.close(); }
});

test("CJK export embeds only covering fallback subsets and rasterizes distinct glyphs without system fonts", async () => {
  const headless = new HeadlessService();
  try {
    const elements = await headless.convert([{ id: "text", type: "text", x: 0, y: 0, text: "中文测试", fontFamily: 5, fontSize: 40 }]);
    const scene: Scene = { elements, files: {}, sharedSettings: { viewBackgroundColor: "#fff" } };
    const svg = await headless.render({ scene, format: "svg", scale: 1, padding: 10, background: true, dark: false });
    assert.match(svg.data, /font-family:"Xiaolai";src:url\(data:font\/woff2;base64,/);
    const fonts = JSON.parse(readFileSync("dist/headless/fonts.json", "utf8")) as { family: string; unicodeRange: string; ranges: [number, number][] }[];
    for (const char of "中文测试") {
      assert(fonts.some(font => font.family === "Xiaolai" && font.ranges.some(([start, end]) => char.codePointAt(0)! >= start && char.codePointAt(0)! <= end) && svg.data.includes(`unicode-range:${font.unicodeRange};`)));
    }
    assert(svg.data.length < 1_000_000, "Do not embed all 209 CJK subsets");
    const png = await headless.render({ scene, format: "png", scale: 1, padding: 10, background: true, dark: false });
    const canvas = createCanvas(png.width, png.height);
    canvas.getContext("2d").drawImage(await loadImage(Buffer.from(png.data, "base64")), 0, 0);
    const first = canvas.getContext("2d").getImageData(10, 10, 40, 40).data;
    const second = canvas.getContext("2d").getImageData(50, 10, 40, 40).data;
    assert.notDeepEqual(first, second, "Glyphs must not all render the same missing-glyph box");
  } finally { await headless.close(); }
});

test("cancellation removes queued jobs and terminates an active job without blocking subsequent work", async () => {
  const headless = new HeadlessService();
  try {
    const activeController = new AbortController();
    const queuedController = new AbortController();
    const active = headless.convert([{ id: "active", type: "rectangle", x: 0, y: 0 }], activeController.signal);
    const queued = headless.render({ scene: { elements: [], files: {}, sharedSettings: { viewBackgroundColor: "#fff" } }, format: "png", scale: 1, padding: 10, background: true, dark: false }, queuedController.signal);
    const rejectedActive = assert.rejects(active, { name: "AbortError" });
    const rejectedQueued = assert.rejects(queued, { name: "AbortError" });
    queuedController.abort();
    activeController.abort();
    await Promise.all([rejectedActive, rejectedQueued]);
    assert.equal((await headless.convert([{ id: "next", type: "rectangle", x: 0, y: 0 }]))[0]!.id, "next");
  } finally { await headless.close(); }
});

test("aggregate image pixel budget is checked before decoding raster data", async () => {
  const headless = new HeadlessService();
  try {
    // A header-only dimension fixture: the worker must reject the aggregate
    // budget before attempting to decode these intentionally incomplete images.
    const header = createCanvas(1, 1).toBuffer("image/png");
    header.writeUInt32BE(4000, 16);
    header.writeUInt32BE(3000, 20);
    const elements = await headless.convert([0, 1, 2].map(i => ({ id: `image${i}`, type: "image", x: i * 100, y: 0, width: 100, height: 100, fileId: `asset${i}` })));
    const files = Object.fromEntries([0, 1, 2].map(i => [`asset${i}`, { id: `asset${i}`, created: 0, mimeType: "image/png" as const, dataURL: `data:image/png;base64,${header.toString("base64")}` }]));
    await assert.rejects(headless.render({ scene: { elements, files, sharedSettings: { viewBackgroundColor: "#fff" } }, format: "png", scale: 1, padding: 10, background: true, dark: false }), /32 megapixel/);
  } finally { await headless.close(); }
});
