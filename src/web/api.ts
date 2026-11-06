import type { CanvasDocument, CanvasListItem, CanvasMetadata } from "../shared/canvas.js";
import type { CanvasComment, CommentState } from "../shared/comments.js";

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

let credentials: (() => { token: string; organizationId?: string | undefined }) | undefined;
export function configureApi(provider?: typeof credentials) { credentials = provider; }

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  const auth = credentials?.();
  if (auth) {
    headers.set("authorization", `Bearer ${auth.token}`);
    if (auth.organizationId) headers.set("x-organization-id", auth.organizationId);
  }
  const response = await fetch(path, { ...options, headers });
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new ApiError(response.status, body.error ?? "Request failed");
  return body;
}

export const api = {
  me: () => request<{ userId: string; organizations: { id: string; name: string }[] }>("/api/auth/me"),
  ticket: (id: string) => request<{ ticket: string }>(`/api/canvases/${id}/live-ticket`, { method: "POST" }),
  list: () => request<CanvasListItem[]>("/api/canvases"),
  create: (title: string) => request<CanvasDocument>("/api/canvases", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }),
  }),
  get: (id: string) => request<CanvasDocument>(`/api/canvases/${id}`),
  rename: (id: string, title: string, expectedTitle: string) => request<CanvasMetadata>(`/api/canvases/${id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, expectedTitle }),
  }),
  deleteCanvas: (id: string, confirmTitle: string, expectedRevision: number) => request<{ canvasId: string; deleted: true }>(`/api/canvases/${id}`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ confirmTitle, expectedRevision }),
  }),
  setVisibility: (id: string, visibility: CanvasMetadata["visibility"], expectedVisibility: CanvasMetadata["visibility"]) => request<CanvasMetadata>(`/api/canvases/${id}/visibility`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ visibility, expectedVisibility }),
  }),
  createComment: (id: string, comment: Omit<CanvasComment, "createdAt">) => request<CommentState>(`/api/canvases/${id}/comments`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(comment),
  }),
  resolveComment: (id: string, commentId: string) => request<CommentState>(`/api/canvases/${id}/comments/${commentId}`, { method: "DELETE" }),
  editComment: (id: string, commentId: string, text: string, expectedText: string) => request<CommentState>(`/api/canvases/${id}/comments/${commentId}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, expectedText }),
  }),
};
