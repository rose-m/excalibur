import { parentPort, workerData } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { imageSize } from "image-size";
import { installDom } from "./dom.js";
import type { HeadlessJob, NativeElement } from "./types.js";

type NativeApi = {
  convertToExcalidrawElements(elements: Record<string, unknown>[], options: { regenerateIds: false }): NativeElement[];
  getCommonBounds(elements: NativeElement[], elementsMap?: Map<string, NativeElement>): [number, number, number, number];
  updateBoundElements(element: NativeElement, elementsMap: Map<string, NativeElement>, options: { simultaneouslyUpdated: NativeElement[] }): void;
  exportToSvg(options: Record<string, unknown>): Promise<SVGElement>;
  exportToCanvas(options: Record<string, unknown>): Promise<HTMLCanvasElement>;
};

try {
  const { win, backing, fonts } = installDom();
  const native = await import(new URL("./excalidraw.mjs", import.meta.url).href) as NativeApi;
  const errors: string[] = [];
  // Native canvas export catches per-element failures. Do not return a partial
  // drawing as successful visual feedback (or log user drawing contents).
  console.error = (...args: unknown[]) => { errors.push(String(args[0])); };
  const job = workerData as HeadlessJob;
  if (job.kind === "convert") {
    const result = native.convertToExcalidrawElements(job.elements, { regenerateIds: false });
    if (errors.length) throw new Error("Native element conversion failed");
    parentPort!.postMessage({ result });
  } else if (job.kind === "bounds") {
    const elementsMap = new Map(job.elements.map(element => [element.id, element]));
    const result = Object.fromEntries(job.elements.filter(element => !element.isDeleted).map(element => {
      const [x1, y1, x2, y2] = native.getCommonBounds([element], elementsMap);
      return [element.id, { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }];
    }));
    parentPort!.postMessage({ result });
  } else if (job.kind === "bindings") {
    const elementsMap = new Map(job.elements.map(element => [element.id, element]));
    const simultaneouslyUpdated = job.simultaneousIds.map(id => elementsMap.get(id)!).filter(Boolean);
    for (const id of job.changedIds) native.updateBoundElements(elementsMap.get(id)!, elementsMap, { simultaneouslyUpdated });
    if (errors.length) throw new Error("Native binding update failed");
    parentPort!.postMessage({ result: [...elementsMap.values()] });
  } else {
    let elements = job.scene.elements.filter(element => !element.isDeleted);
    if (job.elementIds) {
      const selected = new Set(job.elementIds);
      for (const id of selected) if (!elements.some(element => element.id === id)) throw new Error(`Element not found: ${id}`);
      elements = elements.filter(element => selected.has(element.id) || (typeof element.containerId === "string" && selected.has(element.containerId)));
    }
    if (!elements.length) throw new Error("Canvas or selection is empty");
    if (elements.length > 1000) throw new Error("Rendering is limited to 1,000 elements; select a smaller subset");
    const safeColor = /^(?:#[0-9a-f]{3,8}|[a-z]{1,32}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-]+\))$/i;
    for (const element of elements) {
      for (const key of ["strokeColor", "backgroundColor"]) if (typeof element[key] === "string" && !safeColor.test(element[key])) throw new Error("Unsupported render color");
      if (Array.isArray(element.points) && element.points.length > 2000) throw new Error("Too many points to render");
      if (typeof element.text === "string" && element.text.length > 10_000) throw new Error("Text is too large to render");
    }
    if (!safeColor.test(job.scene.sharedSettings.viewBackgroundColor)) throw new Error("Unsupported background color");
    // Never export active links or embedded pages, or load external image URLs.
    elements = elements.map(element => ({ ...element, link: null }));
    const files = Object.fromEntries(Object.entries(job.scene.files).filter(([id]) => elements.some(element => element.fileId === id)));
    for (const element of elements) if (element.type === "image" && !Object.hasOwn(files, String(element.fileId))) throw new Error("Image element is missing its stored raster data");
    let decodedPixels = 0;
    for (const file of Object.values(files)) {
      if (!file.dataURL.startsWith(`data:${file.mimeType};base64,`)) throw new Error("Only stored raster image data URLs can be rendered");
      const size = imageSize(Buffer.from(file.dataURL.split(",")[1]!, "base64"));
      if (!["png", "jpg", "gif", "webp"].includes(size.type ?? "")) throw new Error("Only raster image content can be rendered");
      if (size.width * size.height > 16_000_000 || Math.max(size.width, size.height) > 8192) throw new Error("Image dimensions exceed rendering limits");
      decodedPixels += size.width * size.height;
      if (decodedPixels > 32_000_000) throw new Error("Combined decoded images exceed the 32 megapixel rendering budget");
    }
    const [x1, y1, x2, y2] = native.getCommonBounds(elements);
    const checkSize = (width: number, height: number) => {
      if (![width, height].every(value => Number.isFinite(value) && value >= 1) || Math.max(width, height) > 4096 || width * height > 8_000_000) throw new Error("Render exceeds 4096px / 8 megapixels (or is smaller than 1px); use a subset or another scale");
    };
    checkSize((x2 - x1 + job.padding * 2) * job.scale, (y2 - y1 + job.padding * 2) * job.scale);
    const options = {
      elements, files, exportPadding: job.padding, renderEmbeddables: false,
      appState: { exportBackground: job.background, viewBackgroundColor: job.scene.sharedSettings.viewBackgroundColor, exportWithDarkMode: job.dark, exportScale: job.scale, frameRendering: { enabled: true, name: true, outline: true, clip: true } },
    };
    let data: string;
    let width: number, height: number;
    if (job.format === "svg") {
      const svg = await native.exportToSvg({ ...options, skipInliningFonts: true });
      width = Number(svg.getAttribute("width"));
      height = Number(svg.getAttribute("height"));
      // The exporter adds synthetic frame labels. Its final dimensions, not
      // raw scene bounds, are authoritative for limits and response metadata.
      checkSize(width, height);
      svg.removeAttribute("xmlns");
      for (const text of svg.querySelectorAll("text[font-family]")) {
        if (!text.getAttribute("font-family")!.includes("Xiaolai") && [...(text.textContent ?? "")].some(char => fonts.some(font => font.family === "Xiaolai" && font.ranges.some(([start, end]) => char.codePointAt(0)! >= start && char.codePointAt(0)! <= end)))) {
          text.setAttribute("font-family", `${text.getAttribute("font-family")}, Xiaolai`);
        }
      }
      data = new win.XMLSerializer().serializeToString(svg);
      const used = new Set([...svg.querySelectorAll("text[font-family]")].flatMap(text => text.getAttribute("font-family")!.split(",").map(name => name.trim().replace(/["']/g, ""))));
      const codepoints = new Set([...svg.querySelectorAll("text")].flatMap(text => [...(text.textContent ?? "")].map(char => char.codePointAt(0)!)));
      const css = fonts.filter(font => (used.has(font.family) || font.family === "Liberation Sans" && used.has("Helvetica")) && [...codepoints].some(point => font.ranges.some(([start, end]) => point >= start && point <= end))).map(font => `@font-face{font-family:"${font.family === "Liberation Sans" && used.has("Helvetica") ? "Helvetica" : font.family}";src:url(data:font/woff2;base64,${readFileSync(resolve("dist/headless/fonts", font.file)).toString("base64")}) format("woff2");unicode-range:${font.unicodeRange};}`).join("\n");
      data = data.replace(/<style class="style-fonts">[\s\S]*?<\/style>/, () => `<style class="style-fonts">${css}</style>`);
    } else {
      const canvas = await native.exportToCanvas({ ...options, getDimensions: (w: number, h: number) => {
        checkSize(w * job.scale, h * job.scale);
        const width = Math.ceil(w * job.scale), height = Math.ceil(h * job.scale);
        checkSize(width, height);
        return { width, height, scale: job.scale };
      } });
      width = canvas.width;
      height = canvas.height;
      checkSize(width, height);
      data = backing(canvas).toBuffer("image/png").toString("base64");
    }
    if (errors.length) throw new Error("One or more elements could not be rendered");
    if (Buffer.byteLength(data) > 8 * 1024 * 1024) throw new Error("Rendered output exceeds 8 MiB");
    parentPort!.postMessage({ result: { format: job.format, data, width, height } });
  }
} catch (error) { parentPort!.postMessage({ error: error instanceof Error ? error.message : "Headless operation failed" }); }
