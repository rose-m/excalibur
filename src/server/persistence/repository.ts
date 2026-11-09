import type { CanvasDocument, CanvasMetadata, Scene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasComment, CommentState } from "../../shared/comments.js";

export type SceneCommit = {
  expectedRevision: number;
  scene: Pick<Scene, "elements" | "sharedSettings">;
  // Asset deltas, not a replacement snapshot. Omission preserves existing bytes.
  assets: { upsert: Scene["files"]; remove: string[] };
};

export interface CanvasRepository {
  list(context: OperationContext): Promise<CanvasMetadata[]>;
  create(canvas: CanvasDocument): Promise<void>;
  get(id: string): Promise<CanvasDocument | undefined>;
  // Compare revision, save scene/asset deltas, and advance revision atomically.
  commit(id: string, input: SceneCommit, updatedAt: string): Promise<CanvasMetadata | undefined>;
  setVisibility(id: string, visibility: CanvasMetadata["visibility"], expectedRevision: number, updatedAt: string): Promise<CanvasMetadata | undefined>;
  rename(id: string, title: string, expectedRevision: number, updatedAt: string): Promise<CanvasMetadata | undefined>;
  delete(id: string, expectedRevision: number): Promise<boolean>;
  getComments(id: string): Promise<CommentState>;
  addComment(id: string, comment: CanvasComment): Promise<CommentState | "limit" | "conflict">;
  deleteComment(id: string, commentId: string): Promise<CommentState>;
  editComment(id: string, commentId: string, text: string, expectedText: string): Promise<CommentState | "missing" | "conflict">;
  close(): Promise<void>;
}
