import type { Scene } from "../../shared/canvas.js";
import type { BoundsResult } from "../render/types.js";

export function describeScene(scene: Scene, bounds: BoundsResult) {
  const elements = scene.elements.filter(element => !element.isDeleted);
  const counts: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const element of elements) counts[element.type] = (counts[element.type] ?? 0) + 1;
  return {
    elementCount: elements.length, counts,
    elements: elements.map(element => ({
      id: element.id, type: element.type, bounds: bounds[element.id],
      ...(typeof element.text === "string" ? { text: element.text } : {}),
      ...(typeof element.containerId === "string" ? { containerId: element.containerId } : {}),
      groupIds: element.groupIds ?? [], locked: element.locked ?? false,
    })),
    connections: elements.filter(element => element.type === "arrow").map(element => ({
      id: element.id, from: element.startBinding ?? null, to: element.endBinding ?? null,
    })),
  };
}
