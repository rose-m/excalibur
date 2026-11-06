import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { act, createElement, useEffect } from "react";
import { JSDOM } from "jsdom";
import { api } from "../src/web/api.js";

async function environment() {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://draw.example/" });
  const globals = { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  return { root, document: dom.window.document,
    async click(element: HTMLElement) { await act(async () => { element.click(); }); },
    close(router: ReturnType<typeof import("react-router-dom").createMemoryRouter>) {
      act(() => root.unmount());
      router.dispose();
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

async function guardedFixture(t: TestContext) {
  const env = await environment();
  const { createMemoryRouter, Link, RouterProvider, useLocation } = await import("react-router-dom");
  const { useUnsavedNavigation } = await import("../src/web/use-unsaved-navigation.js");
  let dirty = false;
  let confirmedDelete = false;
  let shellMounts = 0;
  let editorUnmounts = 0;
  const confirm = t.mock.method(window, "confirm", () => false);
  const unsaved = () => dirty && !confirmedDelete;
  function EditorPage() {
    useUnsavedNavigation(unsaved);
    useEffect(() => () => { editorUnmounts++; }, []);
    return createElement(Link, { to: "/" }, "Back to canvases");
  }
  function SessionShell() {
    const { pathname } = useLocation();
    useEffect(() => { shellMounts++; }, []);
    return pathname === "/" ? createElement(Link, { to: "/canvases/one" }, "Open canvas") : createElement(EditorPage, { key: pathname });
  }
  const router = createMemoryRouter([{ path: "*", element: createElement(SessionShell) }], {
    initialEntries: ["/", "/canvases/one", "/canvases/two"], initialIndex: 1,
  });
  await act(async () => { env.root.render(createElement(RouterProvider, { router })); });
  return { ...env, router, confirm, dirty: (value: boolean) => { dirty = value; }, confirmedDelete: () => { confirmedDelete = true; },
    shellMounts: () => shellMounts, editorUnmounts: () => editorUnmounts,
    close: () => env.close(router) };
}

test("internal links keep the session shell mounted and warn before discarding unsaved edits", async t => {
  const f = await guardedFixture(t);
  try {
    f.dirty(true);
    await f.click(f.document.querySelector<HTMLAnchorElement>("a")!);
    assert.equal(f.router.state.location.pathname, "/canvases/one");
    assert.equal(f.editorUnmounts(), 0, "cancelling preserves the mounted editor and its live connection");
    assert.match(f.confirm.mock.calls[0]?.arguments[0] ?? "", /unsaved drawing/);
    f.confirm.mock.mockImplementation(() => true);
    await f.click(f.document.querySelector<HTMLAnchorElement>("a")!);
    assert.equal(f.router.state.location.pathname, "/");
    assert.equal(f.editorUnmounts(), 1);
    assert.equal(f.shellMounts(), 1);
    assert.equal(window.location.pathname, "/", "no document navigation is needed");
  } finally { f.close(); }
});

test("browser Back and Forward honor the same unsaved-changes guard", async t => {
  const f = await guardedFixture(t);
  try {
    f.dirty(true);
    await act(async () => { await f.router.navigate(-1); });
    assert.equal(f.router.state.location.pathname, "/canvases/one");
    assert.equal(f.editorUnmounts(), 0);
    f.confirm.mock.mockImplementation(() => true);
    await act(async () => { await f.router.navigate(-1); });
    assert.equal(f.router.state.location.pathname, "/");
    await act(async () => { await f.router.navigate(1); });
    assert.equal(f.router.state.location.pathname, "/canvases/one");
    f.confirm.mock.mockImplementation(() => false);
    await act(async () => { await f.router.navigate(1); });
    assert.equal(f.router.state.location.pathname, "/canvases/one");
    f.confirm.mock.mockImplementation(() => true);
    await act(async () => { await f.router.navigate(1); });
    assert.equal(f.router.state.location.pathname, "/canvases/two");
    assert.equal(f.shellMounts(), 1);
  } finally { f.close(); }
});

test("saved navigation and already-confirmed deletion do not prompt again", async t => {
  const f = await guardedFixture(t);
  try {
    await f.click(f.document.querySelector<HTMLAnchorElement>("a")!);
    assert.equal(f.router.state.location.pathname, "/");
    await f.click(f.document.querySelector<HTMLAnchorElement>("a")!);
    f.dirty(true);
    f.confirmedDelete();
    await act(async () => { await f.router.navigate("/"); });
    assert.equal(f.router.state.location.pathname, "/");
    assert.equal(f.confirm.mock.callCount(), 0);
    assert.equal(f.shellMounts(), 1);
  } finally { f.close(); }
});

test("the real auth wrapper checks configuration once across client-side page navigation", async t => {
  const f = await environment();
  const { createMemoryRouter, RouterProvider } = await import("react-router-dom");
  const { Auth } = await import("../src/web/Auth.js");
  let authConfigRequests = 0;
  t.mock.method(globalThis, "fetch", async (input: unknown) => {
    assert.equal(input, "/api/auth/config");
    authConfigRequests++;
    return Response.json({ mode: "development" });
  });
  t.mock.method(api, "list", async () => []);
  const router = createMemoryRouter([{ path: "*", element: createElement(Auth) }], { initialEntries: ["/"] });
  try {
    await act(async () => { f.root.render(createElement(RouterProvider, { router })); });
    assert.equal(authConfigRequests, 1);
    await act(async () => { await router.navigate("/missing-page"); });
    assert.match(f.document.body.textContent ?? "", /Page not found/);
    await f.click(f.document.querySelector<HTMLAnchorElement>("main a")!);
    assert.match(f.document.body.textContent ?? "", /My canvases/);
    assert.equal(authConfigRequests, 1, "page navigation did not recreate Auth");
  } finally { f.close(router); }
});
