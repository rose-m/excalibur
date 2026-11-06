import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { NavBar } from "../src/web/NavBar.js";
import { AccountMenu } from "../src/web/AccountMenu.js";
import { StaticRouter } from "react-router-dom";

test("canvas navigation keeps canvas, save and account controls in one bar", () => {
  const markup = renderToStaticMarkup(createElement(StaticRouter, { location: "/" }, createElement(NavBar, {
    title: "A long canvas title <test>",
    accountControls: createElement(AccountMenu, { email: "alice@example.com", organizations: [{ id: "org-a", name: "Organization A" }],
      organizationId: "org-a", onSignOut: () => {} }),
  }, createElement("span", { role: "status" }, "Live · Saved"), createElement("button", null, "Save now"))));
  const dom = new JSDOM(markup);
  try {
    const document = dom.window.document;
    assert.equal(document.querySelectorAll("header").length, 1);
    const nav = document.querySelector('nav[aria-label="Main navigation"]')!;
    assert.equal(nav.querySelector("h1")?.textContent, "A long canvas title <test>");
    assert.equal(nav.querySelector("a")?.getAttribute("href"), "/");
    assert.equal(nav.querySelector("a")?.getAttribute("aria-label"), "Back to canvases");
    assert.equal(nav.querySelector('[role="status"]')?.textContent, "Live · Saved");
    assert.equal(nav.querySelector("button")?.textContent, "Save now");
    assert.equal(nav.querySelector("select"), null, "organization switching belongs inside the account menu");
    assert.match(nav.querySelector('[aria-haspopup="menu"]')?.textContent ?? "", /Account/);
  } finally { dom.window.close(); }
});

test("navigation without a canvas title shows the home brand and optional account controls", () => {
  for (const accountControls of [undefined, createElement("button", null, "Sign out")]) {
    const dom = new JSDOM(renderToStaticMarkup(createElement(StaticRouter, { location: "/" }, createElement(NavBar, { accountControls }))));
    try {
      const document = dom.window.document;
      assert.equal(document.querySelectorAll("header").length, 1);
      assert.equal(document.querySelectorAll("nav").length, 1);
      assert.equal(document.querySelector("a")?.textContent, "Excalibur");
      assert.equal(document.querySelector("h1"), null);
      assert.equal(document.querySelectorAll("button").length, accountControls ? 1 : 0);
    } finally { dom.window.close(); }
  }
});
