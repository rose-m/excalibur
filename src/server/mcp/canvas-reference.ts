import { z } from "zod";
import { ServiceError } from "../canvas/errors.js";

export function resolveCanvasId(reference: string, publicUrl: string, localOrigins?: ReadonlySet<string>): string {
  if (z.uuid().safeParse(reference).success) return reference;
  let url: URL;
  try { url = new URL(reference); } catch { throw new ServiceError(400, "canvasId must be a canvas UUID or this application's canvas URL"); }
  const base = new URL(publicUrl);
  const parts = url.pathname.split("/");
  if (url.origin !== base.origin && !localOrigins?.has(url.origin) || url.username || url.password || parts.length !== 3 || parts[1] !== "canvases" || !z.uuid().safeParse(parts[2]).success) {
    throw new ServiceError(400, "Canvas URL must belong to this application and point to /canvases/:id");
  }
  return parts[2]!;
}

export function canvasUrl(id: string, publicUrl: string) { return new URL(`/canvases/${id}`, publicUrl).href; }
