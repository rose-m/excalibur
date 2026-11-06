import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { CanvasActions } from "../src/web/CanvasActions.js";
import { api, ApiError } from "../src/web/api.js";
import type { CanvasMetadata } from "../src/shared/canvas.js";

async function fixture(t: TestContext, canManage = true, canSave = true) {
  const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: "https://draw.example/canvases/test" });
  const globals = { window: dom.window, document: dom.window.document, Node: dom.window.Node, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "showModal", { configurable: true, value: function (this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(dom.window.HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.open = false; this.dispatchEvent(new dom.window.Event("close")); } });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  let canvas: CanvasMetadata = { id: "test", title: "Team drawing", visibility: "private", creatorUserId: "owner", organizationId: "org", revision: 3, createdAt: "now", updatedAt: "now" };
  let deletions = 0;
  let saves = 0;
  const render = () => root.render(createElement(CanvasActions, { canvas, canManage, canSave, onSave: () => { saves++; }, onUpdate: next => { canvas = next; render(); }, onDeleted: () => { deletions++; } }));
  act(render);
  const get = t.mock.method(api, "get", async () => ({ ...canvas, scene: { elements: [], files: {}, sharedSettings: { viewBackgroundColor: "#fff" } } }));
  const rename = t.mock.method(api, "rename", async (_id: string, title: string) => ({ ...canvas, title, revision: canvas.revision + 1 }));
  const remove = t.mock.method(api, "deleteCanvas", async () => ({ canvasId: canvas.id, deleted: true as const }));
  const document = dom.window.document;
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
  const key = async (element: HTMLElement, value: string) => { await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); }); };
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(element => element.textContent?.trim() === text)!;
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="Canvas actions"]')!;
  const change = async (value: string) => {
    const input = document.querySelector<HTMLInputElement>(".canvas-action-dialog input")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  return { document, trigger, button, click, key, change, get, rename, remove, canvas: () => canvas, deletions: () => deletions, saves: () => saves,
    open: async (mode: "rename" | "delete") => { await click(trigger); await click(button(mode === "rename" ? "Rename canvas" : "Delete canvas…")); },
    close() {
      act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

test("rename dialog validates and trims names, preserving the expected previous name", async t => {
  const f = await fixture(t);
  try {
    await f.open("rename");
    assert.equal(f.document.querySelector<HTMLDialogElement>(".canvas-action-dialog")?.open, true);
    assert.equal(f.button("Save name").disabled, true);
    await f.change("   ");
    assert.equal(f.button("Save name").disabled, true);
    await f.change("  New name  ");
    assert.equal(f.button("Save name").disabled, false);
    await f.click(f.button("Save name"));
    assert.deepEqual(f.rename.mock.calls[0]?.arguments, ["test", "New name", "Team drawing"]);
    assert.equal(f.canvas().title, "New name");
    assert.equal(f.canvas().id, "test");
    assert.equal(f.document.querySelector<HTMLDialogElement>(".canvas-action-dialog")?.open, false);
    assert.equal(f.deletions(), 0);
  } finally { f.close(); }
});

test("delete requires fresh review and exact typed confirmation before navigating", async t => {
  const f = await fixture(t);
  try {
    await f.open("delete");
    assert.equal(f.get.mock.callCount(), 1);
    assert.match(f.document.querySelector(".canvas-delete-warning")?.textContent ?? "", /all its images and comments/);
    assert.match(f.document.querySelector(".share-notice")?.textContent ?? "", /unsaved drawing/);
    assert.equal(f.button("Delete permanently").disabled, true);
    await f.change("team drawing");
    assert.equal(f.button("Delete permanently").disabled, true);
    await f.change("Team drawing");
    assert.equal(f.remove.mock.callCount(), 0);
    await f.click(f.button("Delete permanently"));
    assert.deepEqual(f.remove.mock.calls[0]?.arguments, ["test", "Team drawing", 3]);
    assert.equal(f.deletions(), 1);
  } finally { f.close(); }
});

test("a delete conflict refreshes review and requires another explicit confirmation", async t => {
  const f = await fixture(t);
  try {
    await f.open("delete");
    await f.change("Team drawing");
    f.remove.mock.mockImplementationOnce(async () => { throw new ApiError(409, "Canvas changed. Confirm deletion again."); });
    f.get.mock.mockImplementation(async () => ({ ...f.canvas(), title: "Changed name", revision: 8, scene: { elements: [], files: {}, sharedSettings: { viewBackgroundColor: "#fff" } } }));
    await f.click(f.button("Delete permanently"));
    assert.equal(f.remove.mock.callCount(), 1);
    assert.equal(f.deletions(), 0);
    assert.equal(f.document.querySelector<HTMLInputElement>(".canvas-action-dialog input")?.value, "");
    assert.equal(f.button("Delete permanently").disabled, true);
    assert.match(f.document.querySelector('[role="alert"]')?.textContent ?? "", /Confirm deletion again/);
    await f.change("Changed name");
    await f.click(f.button("Delete permanently"));
    assert.deepEqual(f.remove.mock.calls[1]?.arguments, ["test", "Changed name", 8]);
    assert.equal(f.deletions(), 1);
  } finally { f.close(); }
});

test("rename failures remain visible without changing metadata or retrying automatically", async t => {
  const f = await fixture(t);
  try {
    await f.open("rename");
    await f.change("New name");
    f.rename.mock.mockImplementation(async () => { throw new ApiError(503, "Service unavailable"); });
    await f.click(f.button("Save name"));
    assert.equal(f.canvas().title, "Team drawing");
    assert.match(f.document.querySelector('[role="alert"]')?.textContent ?? "", /unavailable/);
    assert.equal(f.document.querySelector<HTMLDialogElement>(".canvas-action-dialog")?.open, true);
    assert.equal(f.rename.mock.callCount(), 1);
  } finally { f.close(); }
});

test("actions menu supports keyboard navigation, Escape and outside dismissal", async t => {
  const f = await fixture(t);
  try {
    await f.key(f.trigger, "ArrowUp");
    assert.equal(f.document.activeElement, f.button("Delete canvas…"));
    await f.key(f.button("Delete canvas…"), "Home");
    assert.equal(f.document.activeElement, f.button("Save now"));
    await f.key(f.button("Save now"), "Escape");
    assert.equal(f.document.activeElement, f.trigger);
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    await f.click(f.trigger);
    act(() => f.document.getElementById("outside")!.focus());
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  } finally { f.close(); }
});

test("save and sharing live inside the actions dropdown, not in separate navbar buttons", async t => {
  const f = await fixture(t);
  try {
    assert.equal(f.button("Save now"), undefined);
    assert.equal(f.document.querySelector(".share-trigger"), null);
    await f.click(f.trigger);
    assert.deepEqual(Array.from(f.document.querySelectorAll('[role="menuitem"]')).map(item => item.textContent?.trim()),
      ["Save now", "Share canvas Private", "Rename canvas", "Delete canvas…"]);
    await f.click(f.button("Save now"));
    assert.equal(f.saves(), 1);
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    assert.equal(f.document.activeElement, f.trigger);
    await f.click(f.trigger);
    await f.click(f.button("Share canvas Private"));
    const sharing = f.document.querySelector<HTMLDialogElement>("dialog:not(.canvas-action-dialog)")!;
    assert.equal(sharing.open, true);
    assert.equal(f.document.querySelector<HTMLDialogElement>(".canvas-action-dialog")?.open, false);
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    assert.equal(sharing.querySelector("fieldset")?.disabled, false);
    act(() => sharing.close());
    assert.equal(f.document.activeElement, f.trigger);
    await f.click(f.trigger);
    await f.click(f.button("Share canvas Private"));
    assert.equal(sharing.open, true, "sharing can be reopened after closing");
  } finally { f.close(); }
});

test("shared-board members can save and inspect sharing, without rename or delete actions", async t => {
  const f = await fixture(t, false);
  try {
    await f.click(f.trigger);
    assert.deepEqual(Array.from(f.document.querySelectorAll('[role="menuitem"]')).map(item => item.textContent?.trim()), ["Save now", "Share canvas Private"]);
    await f.click(f.button("Save now"));
    assert.equal(f.saves(), 1);
    await f.click(f.trigger);
    await f.click(f.button("Share canvas Private"));
    const sharing = f.document.querySelector<HTMLDialogElement>("dialog:not(.canvas-action-dialog)")!;
    assert.equal(sharing.open, true);
    assert.equal(sharing.querySelector("fieldset")?.disabled, true);
    assert.match(sharing.textContent ?? "", /Only the creator can change sharing/);
  } finally { f.close(); }
});

test("Save now stays disabled when disconnected and keyboard navigation skips it", async t => {
  const f = await fixture(t, false, false);
  try {
    await f.key(f.trigger, "ArrowDown");
    assert.equal(f.button("Save now").disabled, true);
    assert.equal(f.document.activeElement, f.button("Share canvas Private"));
    await f.click(f.button("Save now"));
    assert.equal(f.saves(), 0);
    await f.key(f.button("Share canvas Private"), "ArrowUp");
    assert.equal(f.document.activeElement, f.button("Share canvas Private"));
  } finally { f.close(); }
});

test("an in-flight sharing change cannot reopen the actions dropdown after its dialog closes", async t => {
  const f = await fixture(t);
  try {
    let finish!: (metadata: CanvasMetadata) => void;
    t.mock.method(api, "setVisibility", () => new Promise<CanvasMetadata>(resolve => { finish = resolve; }));
    await f.click(f.trigger);
    await f.click(f.button("Share canvas Private"));
    const sharing = f.document.querySelector<HTMLDialogElement>("dialog:not(.canvas-action-dialog)")!;
    await f.click(sharing.querySelector<HTMLInputElement>('input[value="organization"]')!);
    await f.click(f.button("Save sharing"));
    assert.equal(f.trigger.disabled, true);
    act(() => sharing.close());
    await f.click(f.trigger);
    assert.equal(f.document.querySelector('[role="menu"]'), null);
    await act(async () => { finish({ ...f.canvas(), visibility: "organization", revision: 4 }); });
    assert.equal(f.trigger.disabled, false);
    assert.equal(f.canvas().visibility, "organization");
  } finally { f.close(); }
});
