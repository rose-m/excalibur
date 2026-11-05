import { z } from "zod";
import { mutationSchema } from "./canvas.js";
import type { CanvasDocument, SceneUpdate } from "./canvas.js";

export const selectedElementIdsSchema = z.array(z.string().min(1).max(200)).max(20_000);

export const clientMessageSchema = z.discriminatedUnion("type", [z.strictObject({
  type: z.literal("mutate"),
  requestId: z.string().uuid(),
  mutation: mutationSchema,
}), z.strictObject({ type: z.literal("selection"), elementIds: selectedElementIdsSchema })]);

export type ServerMessage =
  | { type: "snapshot"; canvas: CanvasDocument }
  | { type: "update"; update: SceneUpdate }
  | { type: "ack"; requestId: string; update: SceneUpdate }
  | { type: "error"; requestId?: string; status: number; message: string };
