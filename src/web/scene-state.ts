import type { Scene } from "../shared/canvas.js";

// Native restoration and request validation may reorder object fields. Compare
// document content, not insertion order; element array ordering stays intact.
export function sceneSignature(scene: Scene): string {
  return JSON.stringify(scene, (_key: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    }
    return value;
  });
}
