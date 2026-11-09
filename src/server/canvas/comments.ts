import { z } from "zod";
import { createCommentSchema, editCommentSchema } from "../../shared/comments.js";
import type { CommentState } from "../../shared/comments.js";
import type { CanvasMetadata } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasRepository, CanvasScene } from "../persistence/repository.js";
import { ServiceError } from "./errors.js";
import { subscribeTo } from "./subscriptions.js";

export class CommentService {
  constructor(private repository: CanvasRepository, private canvases: {
    metadata: (context: OperationContext, id: string) => Promise<CanvasMetadata>;
    scene: (context: OperationContext, id: string) => Promise<CanvasScene>;
  }, private exclusive: <T>(id: string, run: () => Promise<T>) => Promise<T>,
  private listeners: Map<string, Set<(state: CommentState) => void>>) {}

  async get(context: OperationContext, id: string) {
    await this.canvases.metadata(context, id);
    return this.repository.getComments(id);
  }

  create(context: OperationContext, id: string, input: unknown) {
    return this.exclusive(id, () => this.createLocked(context, id, input));
  }

  private async createLocked(context: OperationContext, id: string, input: unknown) {
    await this.canvases.metadata(context, id);
    const comment = createCommentSchema.parse(input);
    const anchor = comment.anchor;
    const before = await this.repository.getComments(id);
    if (anchor.type === "element" && !before.comments.some(item => item.id === comment.id)) {
      const canvas = await this.canvases.scene(context, id);
      if (!canvas.scene.elements.some(element => element.id === anchor.elementId && !element.isDeleted)) {
        throw new ServiceError(409, "The attached element is not saved or no longer exists. Save the drawing or choose another point.");
      }
    }
    const result = await this.repository.addComment(id, { ...comment, createdAt: new Date().toISOString() });
    if (result === "limit") throw new ServiceError(413, "A canvas can have at most 500 comments. Resolve a comment first.");
    if (result === "conflict") throw new ServiceError(409, "Comment ID already exists with different content");
    if (result.revision !== before.revision) this.publish(id, result);
    return result;
  }

  edit(context: OperationContext, id: string, commentId: string, input: unknown) {
    return this.exclusive(id, () => this.editLocked(context, id, commentId, input));
  }

  private async editLocked(context: OperationContext, id: string, commentId: string, input: unknown) {
    await this.canvases.metadata(context, id);
    z.uuid().parse(commentId);
    const { text, expectedText } = editCommentSchema.parse(input);
    const before = await this.repository.getComments(id);
    const result = await this.repository.editComment(id, commentId, text, expectedText);
    if (result === "missing") throw new ServiceError(404, "This comment was resolved or no longer exists. Your changes have not been saved.");
    if (result === "conflict") throw new ServiceError(409, "This comment changed elsewhere. Copy your changes, then cancel and reopen Edit to review the latest text.");
    if (result.revision !== before.revision) this.publish(id, result);
    return result;
  }

  resolve(context: OperationContext, id: string, commentId: string) {
    return this.exclusive(id, () => this.resolveLocked(context, id, commentId));
  }

  private async resolveLocked(context: OperationContext, id: string, commentId: string) {
    await this.canvases.metadata(context, id);
    z.uuid().parse(commentId);
    const before = await this.repository.getComments(id);
    const result = await this.repository.deleteComment(id, commentId);
    if (result.revision !== before.revision) this.publish(id, result);
    return result;
  }

  async subscribe(context: OperationContext, id: string, listener: (state: CommentState) => void) {
    await this.canvases.metadata(context, id);
    return subscribeTo(this.listeners, id, listener);
  }

  private publish(id: string, state: CommentState) {
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(state); } catch { console.error("Comment subscriber failed"); }
    }
  }

  forgetCanvas(id: string) { this.listeners.delete(id); }
}
