import type { CanvasDocument, CanvasMetadata, SaveScene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";

export interface CanvasRepository {
  list(context: OperationContext): CanvasMetadata[];
  create(canvas: CanvasDocument): void;
  get(id: string): CanvasDocument | undefined;
  // Compare revision, save snapshot/assets, and advance revision atomically.
  commit(id: string, input: SaveScene, updatedAt: string): CanvasMetadata | undefined;
  close(): void;
}
