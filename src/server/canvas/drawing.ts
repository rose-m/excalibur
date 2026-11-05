import { randomInt, randomUUID } from "node:crypto";
import { generateKeyBetween } from "fractional-indexing";
import type { CanvasDocument, Scene, SceneUpdate } from "../../shared/canvas.js";
import { signature } from "../../shared/signature.js";
import type { OperationContext } from "../auth/context.js";
import type { HeadlessService } from "../render/client.js";
import { batchSchema } from "./drawing-schema.js";
import type { DrawingOperation } from "./drawing-schema.js";
import { ServiceError } from "./errors.js";
import type { CanvasService } from "./service.js";

type Element = Scene["elements"][number];
const fontIds: Record<string, number> = { virgil: 1, hand: 1, handwritten: 1, helvetica: 2, sans: 2, "sans-serif": 2, cascadia: 3, mono: 3, monospace: 3, excalifont: 5, nunito: 6, lilita: 7, comic: 8 };
const geometryKeys = new Set(["x", "y", "width", "height", "points", "angle", "text", "fontSize", "fontFamily", "textAlign", "startElementId", "endElementId"]);
const convertibleTypes = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "text", "image"]);
type Point = [number, number];

function pointsOf(element: Element): Point[] | undefined {
  return Array.isArray(element.points) ? element.points.map(point => Array.isArray(point) ? [Number(point[0]), Number(point[1])] : [(point as { x: number }).x, (point as { y: number }).y]) : undefined;
}

function setLinearSize(element: Element) {
  const points = pointsOf(element);
  if (!points || !["line", "arrow"].includes(element.type)) return;
  element.points = points;
  element.width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0]));
  element.height = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
}

export function activeElement(canvas: CanvasDocument, id: string): Element {
  const element = canvas.scene.elements.find(element => element.id === id && !element.isDeleted);
  if (!element) throw new ServiceError(404, `Element not found: ${id}`);
  return element;
}

function boundRefs(element: Element): { id: string; type: string }[] {
  return Array.isArray(element.boundElements) ? element.boundElements as { id: string; type: string }[] : [];
}

function edge(shape: Element, toward: [number, number]): [number, number] {
  const halfW = Math.max(1, Number(shape.width)) / 2, halfH = Math.max(1, Number(shape.height)) / 2;
  const angle = Number(shape.angle ?? 0), cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = Number(shape.x) + halfW, cy = Number(shape.y) + halfH;
  const dx = (toward[0] - cx) * cos + (toward[1] - cy) * sin;
  const dy = -(toward[0] - cx) * sin + (toward[1] - cy) * cos;
  if (!dx && !dy) return [cx + halfW + 8, cy];
  const factor = shape.type === "ellipse" ? 1 / Math.hypot(dx / halfW, dy / halfH)
    : shape.type === "diamond" ? 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH)
    : 1 / Math.max(Math.abs(dx) / halfW, Math.abs(dy) / halfH);
  const gap = 8 / Math.hypot(dx, dy);
  return [cx + (dx * cos - dy * sin) * (factor + gap), cy + (dx * sin + dy * cos) * (factor + gap)];
}

export class DrawingService {
  constructor(private canvases: CanvasService, private headless: HeadlessService) {}

  async edit(context: OperationContext, canvasId: string, input: unknown, expectedRevision?: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const canvas = this.canvases.get(context, canvasId);
    this.checkRevision(canvas, expectedRevision);
    const operations = batchSchema.parse(input);
    const original = new Map(canvas.scene.elements.map(element => [element.id, element]));
    const working = new Map(canvas.scene.elements.map(element => [element.id, structuredClone(element)]));
    const normalize = new Set<string>();
    const explicitPaths = new Set<string>();
    const deleted = new Set<string>();
    const results: string[] = [];

    for (const operation of operations) {
      if (operation.op === "create") {
        const id = operation.element.id ?? randomUUID();
        if (working.has(id)) throw new ServiceError(409, `Element ID already exists (including tombstones): ${id}`);
        working.set(id, { width: 100, height: operation.element.type === "arrow" || operation.element.type === "line" ? 0 : 100, ...operation.element, id, version: 1, versionNonce: randomInt(0x7fffffff), isDeleted: false });
        const created = working.get(id)!;
        if (operation.element.points) explicitPaths.add(id);
        if (["line", "arrow"].includes(created.type) && !created.points) created.points = [[0, 0], [created.width, created.height]];
        setLinearSize(working.get(id)!);
        normalize.add(id);
        results.push(id);
      } else {
        const element = working.get(operation.id);
        if (!element || element.isDeleted) throw new ServiceError(404, `Element not found: ${operation.id}`);
        if (operation.op === "delete") {
          element.isDeleted = true;
          deleted.add(element.id);
          for (const label of working.values()) if (label.containerId === element.id && !label.isDeleted) { label.isDeleted = true; deleted.add(label.id); }
        } else {
          if (operation.changes.points) explicitPaths.add(element.id);
          // Points are authoritative when supplied. Otherwise dimensions scale
          // the existing path, retaining bends and the direction of each axis.
          let points = pointsOf(element);
          if (points && ["line", "arrow"].includes(element.type) && operation.changes.points === undefined) {
            for (const [axis, key] of [[0, "width"], [1, "height"]] as const) {
              const size = operation.changes[key];
              if (size === undefined) continue;
              const extent = Math.max(...points.map(p => p[axis])) - Math.min(...points.map(p => p[axis]));
              points = points.map((p, i) => {
                const next: Point = [...p];
                next[axis] = extent ? p[axis] * size / extent : size * i / (points!.length - 1);
                return next;
              });
            }
            element.points = points;
          }
          Object.assign(element, operation.changes);
          setLinearSize(element);
          if (element.type === "text" && operation.changes.text !== undefined) element.originalText = operation.changes.text;
          if (Object.keys(operation.changes).some(key => geometryKeys.has(key))) normalize.add(element.id);
        }
        results.push(operation.id);
      }
    }

    // Moving a native frame moves its members once, unless their position was
    // explicitly supplied in the same batch. Resizing changes the frame only.
    for (const frame of working.values()) {
      if (frame.isDeleted || !["frame", "magicframe"].includes(frame.type)) continue;
      const before = original.get(frame.id);
      if (!before) continue;
      const dx = Number(frame.x) - Number(before.x), dy = Number(frame.y) - Number(before.y);
      if (!dx && !dy) continue;
      for (const child of working.values()) {
        if (child.isDeleted || child.frameId !== frame.id) continue;
        const explicit = operations.some(op => op.op === "update" && op.id === child.id && (op.changes.x !== undefined || op.changes.y !== undefined));
        if (explicit) continue;
        child.x = Number(child.x) + dx;
        child.y = Number(child.y) + dy;
        normalize.add(child.id);
      }
    }

    for (const id of normalize) {
      const element = working.get(id)!;
      if (element.type === "text" && typeof element.containerId === "string" && !working.get(element.containerId)?.isDeleted) normalize.add(element.containerId);
    }

    // Keep attached arrows and native bound text in the same atomic mutation.
    for (const element of working.values()) {
      if (element.isDeleted || element.type !== "arrow") continue;
      for (const end of ["start", "end"] as const) {
        const binding = element[`${end}Binding`] as { elementId: string } | null;
        if (binding && deleted.has(binding.elementId)) element[`${end}Binding`] = null;
        else if (binding && normalize.has(binding.elementId)) normalize.add(element.id);
      }
    }
    const skeletons = new Map<string, Record<string, unknown>>();
    const labels = new Set<string>();
    for (const id of normalize) {
      const element = working.get(id)!;
      if (element.isDeleted) continue;
      // Native-only elements (frames, freedraw, embeds) already have complete
      // geometry. They are not skeletons; feeding them to the creation API
      // loses metadata or, for frames without `children`, throws.
      if (!convertibleTypes.has(element.type)) continue;
      if (element.type === "text" && typeof element.containerId === "string" && normalize.has(element.containerId)) continue;
      const skeleton: Record<string, unknown> = { ...element };
      if (typeof skeleton.fontFamily === "string") skeleton.fontFamily = fontIds[skeleton.fontFamily];
      if (Array.isArray(skeleton.points)) skeleton.points = skeleton.points.map(point => Array.isArray(point) ? point : [(point as { x: number }).x, (point as { y: number }).y]);
      if (["rectangle", "ellipse", "diamond"].includes(element.type) && (skeleton.width === 0 || skeleton.height === 0)) throw new ServiceError(400, "Shape dimensions must be positive");
      const existingLabel = [...working.values()].find(item => item.type === "text" && item.containerId === id && !item.isDeleted);
      if (existingLabel && typeof existingLabel.fontFamily === "string") existingLabel.fontFamily = fontIds[existingLabel.fontFamily];
      if (element.type !== "text") {
        const text = typeof element.text === "string" ? element.text : existingLabel?.originalText ?? existingLabel?.text;
        delete skeleton.text;
        skeleton.boundElements = boundRefs(element).filter(ref => ref.type !== "text");
        if (typeof text === "string" && text.length) {
          const labelId = existingLabel?.id ?? randomUUID();
          if (!existingLabel && working.has(labelId)) throw new ServiceError(409, `Generated label ID already exists: ${labelId}`);
          labels.add(labelId);
          skeleton.label = { ...existingLabel, id: labelId, text, originalText: text, textAlign: element.textAlign ?? existingLabel?.textAlign ?? "center", fontSize: element.fontSize ?? existingLabel?.fontSize ?? 20, fontFamily: skeleton.fontFamily ?? existingLabel?.fontFamily ?? 5 };
        } else if (existingLabel) existingLabel.isDeleted = true;
      } else {
        skeleton.text = element.text ?? "";
        // Let native text measurement recompute dimensions after text/font edits.
        delete skeleton.width;
        delete skeleton.height;
      }
      if (element.type === "arrow") {
        const targets: Partial<Record<"start" | "end", Element>> = {};
        for (const end of ["start", "end"] as const) {
          const explicit = element[`${end}ElementId`];
          const binding = element[`${end}Binding`] as { elementId: string } | null;
          const targetId = explicit === null ? null : typeof explicit === "string" ? explicit : binding?.elementId;
          if (targetId) {
            const target = working.get(targetId);
            if (!target || target.isDeleted || !["rectangle", "ellipse", "diamond", "text"].includes(target.type)) throw new ServiceError(400, `Invalid arrow binding target: ${targetId}`);
            if (!original.has(id) || explicit !== undefined) skeleton[end] = { id: targetId };
            targets[end] = target;
            if (skeleton[end] && !normalize.has(targetId)) skeletons.set(targetId, { ...target });
          } else { skeleton[`${end}Binding`] = null; }
          delete skeleton[`${end}ElementId`];
        }
        if (!explicitPaths.has(id) && (!original.has(id) || element.startElementId !== undefined || element.endElementId !== undefined) && (targets.start || targets.end)) {
          const center = (target: Element): [number, number] => [Number(target.x) + Number(target.width) / 2, Number(target.y) + Number(target.height) / 2];
          const points = skeleton.points as [number, number][] | undefined;
          const last = points?.at(-1) ?? [Number(element.width ?? 100), Number(element.height ?? 0)];
          const from: [number, number] = targets.start ? center(targets.start) : [Number(element.x), Number(element.y)];
          const to: [number, number] = targets.end ? center(targets.end) : [Number(element.x) + last[0], Number(element.y) + last[1]];
          const start = targets.start ? edge(targets.start, to) : from;
          const end = targets.end ? edge(targets.end, from) : to;
          Object.assign(skeleton, { x: start[0], y: start[1], width: Math.abs(end[0] - start[0]), height: Math.abs(end[1] - start[1]), points: [[0, 0], [end[0] - start[0], end[1] - start[1]]] });
        }
      }
      skeletons.set(id, skeleton);
    }
    if (skeletons.size > 500) throw new ServiceError(413, "Too many elements affected; split the batch");
    if (skeletons.size) {
      const converted = await this.headless.convert([...skeletons.values()], signal);
      signal?.throwIfAborted();
      for (const element of converted) {
        if (!normalize.has(element.id) && !labels.has(element.id)) continue;
        const before = working.get(element.id);
        if (before && ["arrow", "line"].includes(element.type)) {
          const skeleton = skeletons.get(element.id)!;
          // Skeleton conversion nudges arrow endpoints by 0.5px even without
          // bindings. Reapplying that on every edit causes cumulative drift.
          element.points = structuredClone(skeleton.points);
          element.x = skeleton.x;
          element.y = skeleton.y;
          // The creation API resets bindings and elbow metadata even when they
          // are present in its input. Existing native state is not a skeleton
          // default: retain it unless that endpoint was explicitly rebound.
          for (const end of ["start", "end"] as const) {
            if (before[`${end}ElementId`] === undefined && original.has(element.id)) element[`${end}Binding`] = before[`${end}Binding`] ?? null;
          }
          for (const key of ["fixedSegments", "startIsSpecial", "endIsSpecial", "lastCommittedPoint", "startArrowhead", "endArrowhead"]) {
            if (Object.hasOwn(before, key)) element[key] = before[key];
          }
        }
        if (original.get(element.id)?.type === "text" && !element.containerId && before) {
          element.x = before.x;
          element.y = before.y;
        }
        working.set(element.id, { ...working.get(element.id), ...element });
        setLinearSize(working.get(element.id)!);
      }
    }
    // Rebuild reverse references in linear time, including detach/delete.
    const reverse = new Map<string, { id: string; type: string }[]>();
    const addRef = (target: string, ref: { id: string; type: string }) => {
      const refs = reverse.get(target) ?? [];
      if (!refs.some(item => item.id === ref.id)) refs.push(ref);
      reverse.set(target, refs);
    };
    for (const element of working.values()) {
      if (element.isDeleted) continue;
      if (element.type === "text" && typeof element.containerId === "string") addRef(element.containerId, { id: element.id, type: "text" });
      if (element.type === "arrow") for (const binding of [element.startBinding, element.endBinding]) {
        const target = (binding as { elementId?: string } | null)?.elementId;
        if (target) addRef(target, { id: element.id, type: "arrow" });
      }
    }
    for (const element of working.values()) {
      delete element.startElementId;
      delete element.endElementId;
      if (element.type !== "text") { delete element.text; delete element.fontSize; delete element.fontFamily; }
      const refs = element.isDeleted ? [] : reverse.get(element.id) ?? [];
      if (refs.length || boundRefs(element).length) element.boundElements = refs;
    }
    const changedTargets = [...normalize].filter(id => {
      const element = working.get(id)!;
      return !element.isDeleted && original.has(id) && boundRefs(element).some(ref => ref.type === "arrow");
    });
    if (changedTargets.length) {
      const simultaneous = operations.filter(op => op.op === "update" && ["x", "y", "points", "width", "height"].some(key => Object.hasOwn(op.changes, key))).map(op => (op as Extract<DrawingOperation, { op: "update" }>).id);
      const updated = await this.headless.bindings([...working.values()], changedTargets, simultaneous, signal);
      for (const element of updated) working.set(element.id, element);
    }
    let lastIndex = canvas.scene.elements.at(-1)?.index ?? null;
    const changed: Element[] = [];
    for (const element of working.values()) {
      const previous = original.get(element.id);
      if (previous && signature(previous) === signature(element)) continue;
      if (!previous) { lastIndex = generateKeyBetween(lastIndex, null); element.index = lastIndex; }
      element.version = (previous?.version ?? 0) + 1;
      element.versionNonce = randomInt(0x7fffffff);
      element.updated = Date.now();
      changed.push(element);
    }
    signal?.throwIfAborted();
    const update = this.canvases.mutate(context, canvasId, { elements: changed, expectedRevision: canvas.revision });
    return { ...update, elementIds: results };
  }

  clear(context: OperationContext, canvasId: string, expectedRevision?: number): SceneUpdate {
    const canvas = this.canvases.get(context, canvasId);
    this.checkRevision(canvas, expectedRevision);
    return this.canvases.mutate(context, canvasId, {
      expectedRevision: canvas.revision,
      elements: canvas.scene.elements.filter(element => !element.isDeleted).map(element => ({ ...element, isDeleted: true, version: element.version + 1, versionNonce: randomInt(0x7fffffff), updated: Date.now() })),
    });
  }

  checkRevision(canvas: CanvasDocument, expectedRevision?: number) {
    if (expectedRevision !== undefined && expectedRevision !== canvas.revision) throw new ServiceError(409, "Canvas revision changed. Read the canvas and retry.");
  }

  async transform(context: OperationContext, canvasId: string, ids: string[], transform: (elements: Element[]) => DrawingOperation[] | Promise<DrawingOperation[]>, expectedRevision?: number, signal?: AbortSignal) {
    const canvas = this.canvases.get(context, canvasId);
    this.checkRevision(canvas, expectedRevision);
    if (new Set(ids).size !== ids.length) throw new ServiceError(400, "Duplicate element IDs");
    const elements = ids.map(id => activeElement(canvas, id));
    return this.edit(context, canvasId, await transform(elements), canvas.revision, signal);
  }

  duplicate(context: OperationContext, canvasId: string, ids: string[], offsetX: number, offsetY: number, expectedRevision?: number) {
    const canvas = this.canvases.get(context, canvasId);
    this.checkRevision(canvas, expectedRevision);
    const selected = new Set(ids);
    for (const id of ids) activeElement(canvas, id);
    for (const element of canvas.scene.elements) if (selected.has(element.containerId as string) || selected.has(element.frameId as string)) selected.add(element.id);
    const originals = canvas.scene.elements.filter(element => selected.has(element.id) && !element.isDeleted);
    if (originals.length > 500) throw new ServiceError(413, "Too many elements to duplicate");
    const mapping = new Map(originals.map(element => [element.id, randomUUID()]));
    const groups = new Map<string, string>();
    let index = canvas.scene.elements.at(-1)?.index ?? null;
    const elements = originals.map(original => {
      const element = structuredClone(original);
      element.id = mapping.get(original.id)!;
      element.x = Number(element.x) + offsetX;
      element.y = Number(element.y) + offsetY;
      for (const key of ["containerId", "frameId"]) if (typeof element[key] === "string") element[key] = mapping.get(element[key]) ?? null;
      for (const key of ["startBinding", "endBinding"]) {
        const binding = element[key] as { elementId: string } | null;
        if (binding) element[key] = mapping.has(binding.elementId) ? { ...binding, elementId: mapping.get(binding.elementId) } : null;
      }
      element.boundElements = boundRefs(element).filter(ref => mapping.has(ref.id)).map(ref => ({ ...ref, id: mapping.get(ref.id)! }));
      element.groupIds = ((element.groupIds ?? []) as string[]).map(group => { if (!groups.has(group)) groups.set(group, randomUUID()); return groups.get(group)!; });
      index = generateKeyBetween(index, null);
      Object.assign(element, { index, version: 1, versionNonce: randomInt(0x7fffffff), seed: randomInt(0x7fffffff), updated: Date.now() });
      return element;
    });
    const update = this.canvases.mutate(context, canvasId, { elements, expectedRevision: canvas.revision });
    return { ...update, idMap: Object.fromEntries(mapping) };
  }
}
