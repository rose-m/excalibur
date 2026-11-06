import { z } from "zod";
import { createCommentSchema, editCommentSchema } from "../../shared/comments.js";
import type { CommentState } from "../../shared/comments.js";
import type { CanvasDocument } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasRepository } from "../persistence/repository.js";
import { ServiceError } from "./errors.js";

export class CommentService {
  private listeners = new Map<string, Set<(state: CommentState) => void>>();
  constructor(private repository: CanvasRepository, private access: (context: OperationContext, id: string) => Promise<CanvasDocument>,
    private exclusive: <T>(id: string, run: () => Promise<T>) => Promise<T>) {}

  async get(context: OperationContext, id: string) {
    await this.access(context, id);
    return this.repository.getComments(id);
  }

  create(context: OperationContext, id: string, input: unknown) {
    return this.exclusive(id, () => this.createLocked(context, id, input));
  }

  private async createLocked(context: OperationContext, id: string, input: unknown) {
    const canvas = await this.access(context, id);
    const comment = createCommentSchema.parse(input);
    const anchor = comment.anchor;
    const before = await this.repository.getComments(id);
    if (anchor.type === "element" && !before.comments.some(item => item.id === comment.id)
      && !canvas.scene.elements.some(element => element.id === anchor.elementId && !element.isDeleted)) {
      throw new ServiceError(409, "The attached element is not saved or no longer exists. Save the drawing or choose another point.");
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
    await this.access(context, id);
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
    await this.access(context, id);
    z.uuid().parse(commentId);
    const before = await this.repository.getComments(id);
    const result = await this.repository.deleteComment(id, commentId);
    if (result.revision !== before.revision) this.publish(id, result);
    return result;
  }

  async subscribe(context: OperationContext, id: string, listener: (state: CommentState) => void) {
    await this.access(context, id);
    let listeners = this.listeners.get(id);
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners); }
    listeners.add(listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(id) === listeners) this.listeners.delete(id);
    };
  }

  private publish(id: string, state: CommentState) {
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(state); } catch { console.error("Comment subscriber failed"); }
    }
  }

  forgetCanvas(id: string) { this.listeners.delete(id); }
}
