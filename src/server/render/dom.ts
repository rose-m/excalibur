// Browser bridge adapted from mcp_excalidraw/core/render/excalidraw-node/dom.ts.
// MIT attribution is in THIRD_PARTY_NOTICES.md. Installed only inside a worker.
import { JSDOM, VirtualConsole } from "jsdom";
import { createCanvas, DOMMatrix, GlobalFonts, Image, ImageData, Path2D } from "@napi-rs/canvas";
import type { Canvas } from "@napi-rs/canvas";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function installDom() {
  const fonts = JSON.parse(readFileSync(resolve("dist/headless/fonts.json"), "utf8")) as { family: string; file: string; unicodeRange: string; ranges: [number, number][] }[];
  const faces = fonts.map((font, i) => ({ ...font, alias: `ExcaliburFont${i}` }));
  for (const font of faces) {
    if (!GlobalFonts.registerFromPath(resolve("dist/headless/fonts", font.file), font.alias)) throw new Error(`Could not load bundled font: ${font.file}`);
  }
  const families = [...new Set([...fonts.map(font => font.family), "Helvetica"])].sort((a, b) => b.length - a.length);
  const familyPattern = new RegExp(`(?:"|')?(${families.join("|")})(?:"|')?(?=\\s*(?:,|$))`, "g");
  function fontForText(font: string, text: string) {
    const points = [...new Set([...text].map(char => char.codePointAt(0)!))];
    const resolved = font.replace(familyPattern, (match, family: string) => {
      const name = family === "Helvetica" ? "Liberation Sans" : family;
      const selected = faces.filter(face => face.family === name && points.some(point => face.ranges.some(([start, end]) => point >= start && point <= end)));
      return selected.length ? selected.map(face => face.alias).join(", ") : match;
    });
    // System sans/mono fallbacks are deliberately disabled in the worker. Use
    // the bundled CJK face for missing glyphs even in frame titles/Helvetica.
    const fallback = faces.filter(face => face.family === "Xiaolai" && points.some(point => face.ranges.some(([start, end]) => point >= start && point <= end)));
    return fallback.length ? `${resolved}, ${fallback.map(face => face.alias).join(", ")}` : resolved;
  }
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", {
    pretendToBeVisual: true, url: "http://127.0.0.1/", virtualConsole: new VirtualConsole(),
  });
  const win = dom.window as any;
  const canvases = new WeakMap<object, Canvas>();
  function backing(element: HTMLCanvasElement): Canvas {
    let canvas = canvases.get(element);
    if (!canvas) { canvas = createCanvas(Math.max(1, element.width), Math.max(1, element.height)); canvases.set(element, canvas); }
    if (canvas.width !== Math.max(1, element.width)) canvas.width = Math.max(1, element.width);
    if (canvas.height !== Math.max(1, element.height)) canvas.height = Math.max(1, element.height);
    return canvas;
  }
  win.HTMLCanvasElement.prototype.getContext = function () {
    const element = this;
    const context = backing(this).getContext("2d");
    return new Proxy(context, {
      get(target, key) {
        if (key === "canvas") return element;
        // Skia does not apply browser @font-face unicode-range rules to faces
        // registered with the same family. Use distinct aliases and select the
        // covering subsets for each text operation, including CJK fallback.
        if (key === "measureText" || key === "fillText" || key === "strokeText") return (text: string, ...args: unknown[]) => {
          const previous = target.font;
          target.font = fontForText(previous, text);
          try { return (target[key] as Function)(text, ...args); }
          finally { target.font = previous; }
        };
        if (key === "drawImage") return (image: any, ...args: any[]) => (target.drawImage as Function)(
          image instanceof win.HTMLCanvasElement ? backing(image) : image, ...args);
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
  };
  win.HTMLCanvasElement.prototype.toDataURL = function () { return backing(this).toDataURL("image/png"); };
  win.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.FontFace = class {
    status = "loaded";
    constructor(public family: string, _source: unknown, public descriptors: Record<string, unknown> = {}) {}
    load() { return Promise.resolve(this); }
  };
  Object.defineProperty(win.document, "fonts", { value: {
    has: () => true, check: () => true, load: async () => [], ready: Promise.resolve(),
    add() {}, [Symbol.iterator]: function* () {},
  } });
  win.Image = Image;
  win.Path2D = Path2D;
  win.DOMMatrix = DOMMatrix;
  win.ImageData = ImageData;
  for (const key of ["window", "document", "navigator", "location", "self", "top", "parent", "frames", "localStorage", "sessionStorage", "HTMLElement", "HTMLCanvasElement", "HTMLImageElement", "Image", "SVGElement", "Node", "Element", "DOMParser", "XMLSerializer", "FontFace", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame", "matchMedia", "ResizeObserver", "MutationObserver", "CustomEvent", "Path2D", "DOMMatrix", "ImageData", "devicePixelRatio"]) {
    Object.defineProperty(globalThis, key, { configurable: true, value: ["window", "self", "top", "parent"].includes(key) ? win : win[key] });
  }
  return { win, backing, fonts };
}
