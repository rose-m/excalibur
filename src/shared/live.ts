import { z } from "zod";
import { mutationSchema } from "./canvas.js";
import type { CanvasDocument, SceneUpdate } from "./canvas.js";

export const clientMessageSchema = z.strictObject({
  type: z.literal("mutate"),
  requestId: z.string().uuid(),
  mutation: mutationSchema,
});

export type ServerMessage =
  | { type: "snapshot"; canvas: CanvasDocument }
  | { type: "update"; update: SceneUpdate }
  | { type: "ack"; requestId: string; update: SceneUpdate }
  | { type: "error"; requestId?: string; status: number; message: string };
