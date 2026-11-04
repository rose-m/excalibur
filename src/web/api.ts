import type { CanvasDocument, CanvasMetadata, SaveScene } from "../shared/canvas.js";

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
  save: (id: string, input: SaveScene) => request<CanvasMetadata>(`/api/canvases/${id}`, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input),
  }),
};
