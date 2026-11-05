import type { CanvasDocument, CanvasMetadata } from "../shared/canvas.js";
import type { CanvasComment, CommentState } from "../shared/comments.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, options);
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "Request failed");
  return body;
}

export const api = {
  list: () => request<CanvasMetadata[]>("/api/canvases"),
  create: (title: string) => request<CanvasDocument>("/api/canvases", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
  }),
  get: (id: string) => request<CanvasDocument>(`/api/canvases/${id}`),
  createComment: (id: string, comment: Omit<CanvasComment, "createdAt">) => request<CommentState>(`/api/canvases/${id}/comments`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(comment),
  }),
  resolveComment: (id: string, commentId: string) => request<CommentState>(`/api/canvases/${id}/comments/${commentId}`, { method: "DELETE" }),
  editComment: (id: string, commentId: string, text: string, expectedText: string) => request<CommentState>(`/api/canvases/${id}/comments/${commentId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, expectedText }),
  }),
};
