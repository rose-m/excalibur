import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { commentShortcutTarget, isCommentShortcut } from "../src/web/comment-shortcut.js";

const plain = { key: "c", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, repeat: false, isComposing: false, defaultPrevented: false };

test("plain C activates comments without intercepting modifiers, repeats, composition or handled keys", () => {
  assert(isCommentShortcut(plain));
  assert(isCommentShortcut({ ...plain, key: "C" }));
  assert(!isCommentShortcut({ ...plain, key: "v" }));
  for (const flag of ["altKey", "ctrlKey", "metaKey", "shiftKey", "repeat", "isComposing", "defaultPrevented"] as const) {
    assert(!isCommentShortcut({ ...plain, [flag]: true }), flag);
  }
});

test("comment shortcut excludes editable fields, dialogs and menu controls", () => {
  const dom = new JSDOM(`<main><canvas></canvas><button>Comment</button><input><textarea></textarea><select></select>
    <div contenteditable="true"><span id="nested-editable"></span></div><div contenteditable="false" id="not-editable"></div>
    <div role="textbox"></div><div role="dialog"><button id="dialog-button"></button></div><div role="menu"><span id="menu-item"></span></div>
    <div role="listbox"></div><div role="combobox"></div></main>`);
  try {
    const document = dom.window.document;
    for (const selector of ["canvas", "main > button", "#not-editable"]) assert(commentShortcutTarget(document.querySelector(selector)!));
    for (const selector of ["input", "textarea", "select", "#nested-editable", '[role="textbox"]', "#dialog-button", "#menu-item", '[role="listbox"]', '[role="combobox"]']) {
      assert(!commentShortcutTarget(document.querySelector(selector)!), selector);
    }
  } finally { dom.window.close(); }
});
