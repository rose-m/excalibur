import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { act, createElement } from "react";
import { JSDOM } from "jsdom";
import { api } from "../src/web/api.js";
import type { CanvasMetadata } from "../src/shared/canvas.js";

const metadata = { organizationId: "org-a", revision: 0, createdAt: "2026-11-06T10:00:00Z", updatedAt: "2026-11-06T10:00:00Z" };
const canvases: CanvasMetadata[] = [
  { ...metadata, id: "mine-private", title: "Personal notes", creatorUserId: "alice", visibility: "private" },
  { ...metadata, id: "mine-shared", title: "Team ROADMAP", creatorUserId: "alice", visibility: "organization" },
  { ...metadata, id: "other-shared", title: "Team architecture", creatorUserId: "bob", visibility: "organization" },
];

async function fixture(t: TestContext, items: CanvasMetadata[] | Promise<CanvasMetadata[]> = canvases, userId = "alice") {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://draw.example/" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const list = t.mock.method(api, "list", async () => items);
  const { CanvasList } = await import("../src/web/CanvasList.js");
  const { createMemoryRouter, RouterProvider } = await import("react-router-dom");
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  const router = createMemoryRouter([
    { path: "/", element: createElement(CanvasList, { authenticated: true, userId }) },
    { path: "/canvases/:id", element: createElement("p", null, "Canvas opened") },
  ], { initialEntries: ["/"] });
  await act(async () => { root.render(createElement(RouterProvider, { router })); });
  const document = dom.window.document;
  const click = async (element: HTMLElement) => { await act(async () => { element.click(); }); };
  const key = async (element: HTMLElement, value: string) => { await act(async () => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); }); };
  const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
  const change = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const titles = () => Array.from(document.querySelectorAll(".canvas-card h2")).map(item => item.textContent);
  return { document, click, key, search, change, tabs, titles, list, router,
    close() {
      act(() => root.unmount());
      router.dispose();
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

test("canvas tabs separate ownership from organization sharing, including one's shared canvases in both", async t => {
  const f = await fixture(t);
  try {
    assert.deepEqual(f.titles(), ["Personal notes", "Team ROADMAP"]);
    assert.equal(f.tabs[0]!.getAttribute("aria-selected"), "true");
    assert.deepEqual(Array.from(f.document.querySelectorAll(".canvas-tab-count")).map(item => item.textContent), ["2", "2"]);
    assert.equal(f.document.querySelector("img"), null, "the list has no thumbnail previews");
    await f.click(f.tabs[1]!);
    assert.deepEqual(f.titles(), ["Team ROADMAP", "Team architecture"]);
    assert.equal(f.tabs[1]!.getAttribute("aria-selected"), "true");
    assert.equal(f.document.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby"), f.tabs[1]!.id);
    assert.equal(f.document.querySelector(".canvas-card")?.getAttribute("href"), "/canvases/mine-shared");
    assert.match(f.document.querySelector(".canvas-card p")?.textContent ?? "", /Organization/);
    assert.equal(f.list.mock.callCount(), 1, "switching tabs does not refetch the same authorized list");
  } finally { f.close(); }
});

test("search matches titles case-insensitively and persists when switching groups", async t => {
  const f = await fixture(t);
  try {
    await f.change(f.search, "  tEAM  ");
    assert.deepEqual(f.titles(), ["Team ROADMAP"]);
    assert.equal(f.document.querySelector(".canvas-results")?.textContent, "1 canvas found");
    await f.click(f.tabs[1]!);
    assert.equal(f.search.value, "  tEAM  ");
    assert.deepEqual(f.titles(), ["Team ROADMAP", "Team architecture"]);
    assert.equal(f.document.querySelector(".canvas-results")?.textContent, "2 canvases found");
    await f.change(f.search, "roadmap");
    assert.deepEqual(f.titles(), ["Team ROADMAP"]);
    await f.change(f.search, "nothing matches");
    assert.deepEqual(f.titles(), []);
    assert.match(f.document.querySelector(".empty")?.textContent ?? "", /No canvases match/);
    const clear = Array.from(f.document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Clear search")!;
    await f.click(clear);
    assert.equal(f.search.value, "");
    assert.deepEqual(f.titles(), ["Team ROADMAP", "Team architecture"]);
  } finally { f.close(); }
});

test("empty groups explain ownership and sharing instead of showing a search failure", async t => {
  const f = await fixture(t, [], "new-user");
  try {
    assert.match(f.document.querySelector(".empty")?.textContent ?? "", /haven't created any canvases/);
    await f.click(f.tabs[1]!);
    assert.match(f.document.querySelector(".empty")?.textContent ?? "", /No canvases are shared/);
    assert.equal(f.document.querySelector(".canvas-results")?.textContent, "0 canvases");
  } finally { f.close(); }
});

test("canvas tabs support arrow keys, Home and End with a single keyboard tab stop", async t => {
  const f = await fixture(t);
  try {
    assert.deepEqual(f.tabs.map(tab => tab.tabIndex), [0, -1]);
    await f.key(f.tabs[0]!, "ArrowRight");
    assert.equal(f.document.activeElement, f.tabs[1]);
    assert.deepEqual(f.tabs.map(tab => tab.tabIndex), [-1, 0]);
    await f.key(f.tabs[1]!, "ArrowRight");
    assert.equal(f.document.activeElement, f.tabs[0]);
    await f.key(f.tabs[0]!, "End");
    assert.equal(f.document.activeElement, f.tabs[1]);
    await f.key(f.tabs[1]!, "Home");
    assert.equal(f.document.activeElement, f.tabs[0]);
    await f.key(f.tabs[0]!, "ArrowLeft");
    assert.equal(f.document.activeElement, f.tabs[1]);
  } finally { f.close(); }
});

test("loading and list failures do not claim that a group is empty", async t => {
  let reject!: (error: Error) => void;
  const pending = new Promise<CanvasMetadata[]>((_resolve, fail) => { reject = fail; });
  const f = await fixture(t, pending);
  try {
    assert.equal(f.document.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy"), "true");
    assert.match(f.document.querySelector('[role="status"]')?.textContent ?? "", /Loading canvases/);
    assert.equal(f.document.querySelector(".empty"), null);
    await act(async () => { reject(new Error("Could not load canvases")); });
    assert.match(f.document.querySelector('[role="alert"]')?.textContent ?? "", /Could not load canvases/);
    assert.equal(f.document.querySelector(".empty"), null);
    assert.equal(f.document.querySelector('[role="tabpanel"]')?.getAttribute("aria-busy"), "false");
  } finally { f.close(); }
});

test("opening a canvas uses client-side navigation", async t => {
  const f = await fixture(t);
  try {
    await f.click(f.document.querySelector<HTMLAnchorElement>(".canvas-card")!);
    assert.equal(f.router.state.location.pathname, "/canvases/mine-private");
    assert.match(f.document.body.textContent ?? "", /Canvas opened/);
    assert.equal(window.location.pathname, "/", "the document was not reloaded or navigated");
  } finally { f.close(); }
});

test("creating a canvas opens it without a document reload", async t => {
  const f = await fixture(t);
  try {
    const create = t.mock.method(api, "create", async () => ({ ...canvases[0]!, id: "created", scene: { elements: [], files: {}, sharedSettings: { viewBackgroundColor: "#fff" } } }));
    await f.change(f.document.querySelector<HTMLInputElement>('input:not([type="search"])')!, "New canvas");
    const button = Array.from(f.document.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === "Create canvas")!;
    await f.click(button);
    assert.deepEqual(create.mock.calls[0]?.arguments, ["New canvas"]);
    assert.equal(f.router.state.location.pathname, "/canvases/created");
    assert.equal(window.location.pathname, "/");
  } finally { f.close(); }
});
