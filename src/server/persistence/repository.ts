import type { CanvasDocument, CanvasMetadata, SaveScene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasComment, CommentState } from "../../shared/comments.js";

export interface CanvasRepository {
  list(context: OperationContext): Promise<CanvasMetadata[]>;
  create(canvas: CanvasDocument): Promise<void>;
  get(id: string): Promise<CanvasDocument | undefined>;
  // Compare revision, save snapshot/assets, and advance revision atomically.
  commit(id: string, input: SaveScene, updatedAt: string): Promise<CanvasMetadata | undefined>;
  setVisibility(id: string, visibility: CanvasMetadata["visibility"], expectedRevision: number, updatedAt: string): Promise<CanvasMetadata | undefined>;
  rename(id: string, title: string, expectedRevision: number, updatedAt: string): Promise<CanvasMetadata | undefined>;
  delete(id: string, expectedRevision: number): Promise<boolean>;
  getComments(id: string): Promise<CommentState>;
  addComment(id: string, comment: CanvasComment): Promise<CommentState | "limit" | "conflict">;
  deleteComment(id: string, commentId: string): Promise<CommentState>;
  editComment(id: string, commentId: string, text: string, expectedText: string): Promise<CommentState | "missing" | "conflict">;
  close(): Promise<void>;
}
