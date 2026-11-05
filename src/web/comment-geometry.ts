import type { Scene } from "../shared/canvas.js";
import type { CommentAnchor } from "../shared/comments.js";

type Element = Scene["elements"][number];
type Point = { x: number; y: number };

function points(element: Element): Point[] {
  if (!Array.isArray(element.points)) return [];
  return element.points.filter((p): p is [number, number] => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map(([x, y]) => ({ x: Number(element.x) + x, y: Number(element.y) + y }));
}

function box(element: Element) {
  const path = points(element);
  let x = Number(element.x), y = Number(element.y), right = x + Number(element.width), bottom = y + Number(element.height);
  if (path.length) {
    x = y = Infinity; right = bottom = -Infinity;
    for (const point of path) { x = Math.min(x, point.x); y = Math.min(y, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
  }
  const width = right - x, height = bottom - y;
  return { x, y, width, height, cx: x + width / 2, cy: y + height / 2 };
}

function rotate(point: Point, center: { cx: number; cy: number }, angle: number): Point {
  const x = point.x - center.cx, y = point.y - center.cy;
  return { x: center.cx + x * Math.cos(angle) - y * Math.sin(angle), y: center.cy + x * Math.sin(angle) + y * Math.cos(angle) };
}

export function anchorAt(point: Point, element?: Element): CommentAnchor {
  if (!element) return { type: "canvas", ...point };
  const bounds = box(element);
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return { type: "canvas", ...point };
  const local = rotate(point, bounds, -Number(element.angle ?? 0));
  return { type: "element", elementId: element.id, ...point,
    u: bounds.width ? Math.max(0, Math.min(1, (local.x - bounds.x) / bounds.width)) : 0.5,
    v: bounds.height ? Math.max(0, Math.min(1, (local.y - bounds.y) / bounds.height)) : 0.5 };
}

export function commentPosition(anchor: CommentAnchor, elements: ReadonlyMap<string, Element>): Point {
  if (anchor.type === "canvas") return { x: anchor.x, y: anchor.y };
  const element = elements.get(anchor.elementId);
  // Tombstones retain the last geometry, so deleting a drawing element does
  // not delete its notes or make their pins jump. Missing targets use fallback.
  if (!element) return { x: anchor.x, y: anchor.y };
  const bounds = box(element);
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) return { x: anchor.x, y: anchor.y };
  return rotate({ x: bounds.x + bounds.width * anchor.u, y: bounds.y + bounds.height * anchor.v }, bounds, Number(element.angle ?? 0));
}

function distanceToSegment(point: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = dx || dy ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

export function commentTarget(point: Point, elements: readonly Element[], zoom: number): Element | undefined {
  const byId = new Map(elements.map(element => [element.id, element]));
  for (let i = elements.length - 1; i >= 0; i--) {
    const element = elements[i]!;
    if (element.isDeleted) continue;
    const bounds = box(element), local = rotate(point, bounds, -Number(element.angle ?? 0));
    const path = points(element);
    let hit: boolean;
    if (path.length) hit = path.some((p, index) => index > 0 && distanceToSegment(local, path[index - 1]!, p) <= 8 / zoom);
    else if (element.type === "ellipse") hit = Math.hypot((local.x - bounds.cx) / (bounds.width / 2), (local.y - bounds.cy) / (bounds.height / 2)) <= 1;
    else if (element.type === "diamond") hit = Math.abs((local.x - bounds.cx) / (bounds.width / 2)) + Math.abs((local.y - bounds.cy) / (bounds.height / 2)) <= 1;
    else hit = local.x >= bounds.x && local.x <= bounds.x + bounds.width && local.y >= bounds.y && local.y <= bounds.y + bounds.height;
    if (hit) {
      const container = typeof element.containerId === "string" ? byId.get(element.containerId) : undefined;
      return container && !container.isDeleted ? container : element;
    }
  }
}
