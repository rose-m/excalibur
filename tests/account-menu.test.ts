import assert from "node:assert/strict";
import { test } from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AccountMenu } from "../src/web/AccountMenu.js";

function fixture(organizationId: string | undefined = "org-a", organizations = [{ id: "org-a", name: "Organization A" }, { id: "org-b", name: "Organization B" }]) {
  const dom = new JSDOM('<div id="root"></div><button id="outside">Outside</button>', { url: "https://draw.example/canvases/current" });
  const globals = { window: dom.window, document: dom.window.document, Node: dom.window.Node,
    HTMLAnchorElement: dom.window.HTMLAnchorElement, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.fromEntries(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  let signOuts = 0;
  act(() => root.render(createElement(AccountMenu, { email: "alice@example.com", organizations, organizationId, onSignOut: () => { signOuts++; } })));
  const document = dom.window.document;
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  const click = (element: HTMLElement) => act(() => element.click());
  const key = (element: HTMLElement, value: string) => act(() => { element.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
  return { document, trigger, click, key, signOuts: () => signOuts,
    close() {
      act(() => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(previous)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    } };
}

test("account dropdown contains organizations, marks the active org and keeps switching as navigation", () => {
  const f = fixture();
  try {
    assert.equal(f.document.querySelector("select"), null);
    assert.equal(f.document.querySelector('[role="menu"]'), null);
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    f.click(f.trigger);
    const menu = f.document.querySelector<HTMLElement>('[role="menu"]')!;
    assert.equal(f.trigger.getAttribute("aria-controls"), menu.id);
    assert.match(menu.textContent!, /alice@example.com/);
    const selected = menu.querySelector<HTMLAnchorElement>('[aria-checked="true"]')!;
    assert.match(selected.textContent!, /Organization A/);
    assert.equal(f.document.activeElement, selected);
    assert.equal(menu.querySelector('[aria-checked="false"]')?.getAttribute("href"), "/?organization=org-b");
    f.click(selected);
    assert.equal(f.document.querySelector('[role="menu"]'), null, "selecting the active organization closes without reloading");
    assert.equal(f.document.activeElement, f.trigger);
  } finally { f.close(); }
});

test("account dropdown supports arrows, Home/End, Escape, Tab and sign out", () => {
  const f = fixture();
  try {
    f.key(f.trigger, "ArrowDown");
    const items = Array.from(f.document.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]'));
    assert.equal(f.document.activeElement, items[0]);
    f.key(items[0]!, "ArrowDown");
    assert.equal(f.document.activeElement, items[1]);
    f.key(items[1]!, "End");
    assert.equal(f.document.activeElement, items[2]);
    f.key(items[2]!, "ArrowDown");
    assert.equal(f.document.activeElement, items[0]);
    f.key(items[0]!, "End");
    f.key(items[2]!, "Home");
    assert.equal(f.document.activeElement, items[0]);
    f.key(items[0]!, "Escape");
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    assert.equal(f.document.activeElement, f.trigger);
    f.key(f.trigger, "ArrowUp");
    const signOut = f.document.querySelector<HTMLElement>('[role="menuitem"]')!;
    assert.equal(f.document.activeElement, signOut);
    f.click(signOut);
    assert.equal(f.signOuts(), 1);
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    f.click(f.trigger);
    f.key(f.document.activeElement as HTMLElement, "Tab");
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  } finally { f.close(); }
});

test("account dropdown dismisses on outside focus and pointer interaction", () => {
  const f = fixture();
  try {
    f.click(f.trigger);
    const outside = f.document.getElementById("outside")!;
    act(() => outside.focus());
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
    assert.equal(f.document.activeElement, outside);
    f.click(f.trigger);
    act(() => { outside.dispatchEvent(new window.Event("pointerdown", { bubbles: true })); });
    assert.equal(f.trigger.getAttribute("aria-expanded"), "false");
  } finally { f.close(); }
});

test("accounts without organizations can still sign out", () => {
  const f = fixture(undefined, []);
  try {
    f.click(f.trigger);
    assert.equal(f.document.querySelector('[role="group"]'), null);
    const signOut = f.document.querySelector<HTMLElement>('[role="menuitem"]')!;
    assert.equal(f.document.activeElement, signOut);
    f.click(signOut);
    assert.equal(f.signOuts(), 1);
  } finally { f.close(); }
});
