import type { CanvasDocument, CanvasMetadata, SaveScene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasComment, CommentState } from "../../shared/comments.js";

export interface CanvasRepository {
  list(context: OperationContext): CanvasMetadata[];
  create(canvas: CanvasDocument): void;
  get(id: string): CanvasDocument | undefined;
  // Compare revision, save snapshot/assets, and advance revision atomically.
  commit(id: string, input: SaveScene, updatedAt: string): CanvasMetadata | undefined;
  setVisibility(id: string, visibility: CanvasMetadata["visibility"], expectedRevision: number, updatedAt: string): CanvasMetadata | undefined;
  getComments(id: string): CommentState;
  addComment(id: string, comment: CanvasComment): CommentState | "limit" | "conflict";
  deleteComment(id: string, commentId: string): CommentState;
  editComment(id: string, commentId: string, text: string, expectedText: string): CommentState | "missing" | "conflict";
  close(): void;
}
