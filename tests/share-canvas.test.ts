import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ShareCanvas } from "../src/web/ShareCanvas.js";
import { api, ApiError } from "../src/web/api.js";
import type { CanvasMetadata } from "../src/shared/canvas.js";

function fixture(t: TestContext, canManage = true) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://draw.example/canvases/test" });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; } });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let canvas: CanvasMetadata = { id: "test", title: "Team drawing", visibility: "private", creatorUserId: "owner", organizationId: "org", revision: 0, createdAt: "now", updatedAt: "now" };
  const changes: CanvasMetadata[] = [];
  const render = () => root.render(createElement(ShareCanvas, { canvas, canManage, onUpdate: next => { canvas = next; changes.push(next); render(); } }));
  act(render);
  const document = dom.window.document;
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(element => element.textContent?.trim() === text)!;
  const save = t.mock.method(api, "setVisibility", async (_id: string, visibility: CanvasMetadata["visibility"]) => ({ ...canvas, visibility, revision: canvas.revision + 1 }));
  return { document, click, button, changes, save,
    canvas: () => canvas,
    open: () => click(document.querySelector<HTMLButtonElement>(".share-trigger")!),
    select: (visibility: string) => click(document.querySelector<HTMLInputElement>(`input[value="${visibility}"]`)!),
    close() {
      act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

test("creator sharing dialog saves explicit visibility and keeps canvas links private", async t => {
  const f = fixture(t);
  try {
    await f.open();
    assert.equal(f.document.querySelector("dialog")?.open, true);
    assert.equal(f.button("Save sharing").disabled, true);
    assert.equal(f.document.querySelector<HTMLInputElement>("#canvas-share-url")?.value, "https://draw.example/canvases/test");
    await f.select("organization");
    await f.click(f.button("Save sharing"));
    assert.deepEqual(f.save.mock.calls[0]?.arguments, ["test", "organization", "private"]);
    assert.equal(f.canvas().visibility, "organization");
    assert.equal(f.document.querySelector("dialog")?.open, false);
    assert.match(f.document.querySelector(".sharing-badge")?.textContent ?? "", /Organization/);
    await f.open();
    await f.select("private");
    assert.match(f.document.querySelector(".share-notice")?.textContent ?? "", /Already-open live connections/);
    await f.click(f.button("Save sharing"));
    assert.deepEqual(f.save.mock.calls[1]?.arguments, ["test", "private", "organization"]);
    assert.equal(f.canvas().visibility, "private");
  } finally { f.close(); }
});

test("non-creators can inspect sharing and copy a link but cannot change visibility", async t => {
  const f = fixture(t, false);
  try {
    await f.open();
    assert.equal(f.document.querySelector("fieldset")?.disabled, true);
    assert.equal(f.button("Save sharing"), undefined);
    assert.match(f.document.querySelector(".share-notice")?.textContent ?? "", /Only the creator/);
    let copied = "";
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => { copied = text; } } });
    await f.click(f.button("Copy link"));
    assert.equal(copied, "https://draw.example/canvases/test");
    assert.equal(f.document.querySelector('[role="status"]')?.textContent, "Link copied");
    assert.equal(f.save.mock.callCount(), 0);
  } finally { f.close(); }
});

test("sharing errors leave access unchanged and conflicts refresh without automatic retries", async t => {
  const f = fixture(t);
  try {
    await f.open();
    await f.select("organization");
    f.save.mock.mockImplementation(async () => { throw new ApiError(503, "Sharing service unavailable"); });
    await f.click(f.button("Save sharing"));
    assert.equal(f.canvas().visibility, "private");
    assert.equal(f.document.querySelector("dialog")?.open, true);
    assert.match(f.document.querySelector('[role="alert"]')?.textContent ?? "", /unavailable/);
    f.save.mock.mockImplementation(async () => { throw new ApiError(409, "Sharing changed. Review and try again."); });
    t.mock.method(api, "get", async () => ({ ...f.canvas(), visibility: "organization", revision: 5, scene: { elements: [], files: {}, sharedSettings: { viewBackgroundColor: "#fff" } } }));
    await f.click(f.button("Save sharing"));
    assert.equal(f.save.mock.callCount(), 2);
    assert.equal(f.canvas().visibility, "organization");
    assert.equal(f.button("Save sharing").disabled, true);
    assert.match(f.document.querySelector('[role="alert"]')?.textContent ?? "", /Sharing changed/);
  } finally { f.close(); }
});
