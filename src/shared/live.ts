import { z } from "zod";
import { mutationSchema } from "./canvas.js";
import type { CanvasDocument, CanvasMetadata, SceneUpdate } from "./canvas.js";
import type { CommentState } from "./comments.js";

export const selectedElementIdsSchema = z.array(z.string().min(1).max(200)).max(20_000);

export const clientMessageSchema = z.discriminatedUnion("type", [z.strictObject({
  type: z.literal("mutate"),
  requestId: z.string().uuid(),
  mutation: mutationSchema,
}), z.strictObject({ type: z.literal("selection"), elementIds: selectedElementIdsSchema })]);

export type ServerMessage =
  | { type: "snapshot"; canvas: CanvasDocument; comments?: CommentState }
  | { type: "comments"; state: CommentState }
  | { type: "metadata"; metadata: CanvasMetadata }
  | { type: "deleted"; canvasId: string }
  | { type: "update"; update: SceneUpdate }
  | { type: "ack"; requestId: string; update: SceneUpdate }
  | { type: "error"; requestId?: string; status: number; message: string };
