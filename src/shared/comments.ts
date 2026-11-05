import { z } from "zod";

const coordinate = z.number().finite().min(-2_000_000).max(2_000_000);
export const commentAnchorSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("canvas"), x: coordinate, y: coordinate }),
  z.strictObject({ type: z.literal("element"), elementId: z.string().min(1).max(200), u: z.number().min(0).max(1), v: z.number().min(0).max(1), x: coordinate, y: coordinate }),
]);
export const createCommentSchema = z.strictObject({
  id: z.uuid(), text: z.string().trim().min(1).max(4000), anchor: commentAnchorSchema,
});
export const editCommentSchema = z.strictObject({
  text: createCommentSchema.shape.text,
  expectedText: z.string().min(1).max(4000),
});
export type CommentAnchor = z.infer<typeof commentAnchorSchema>;
export type CanvasComment = z.infer<typeof createCommentSchema> & { createdAt: string };
export type CommentState = { revision: number; comments: CanvasComment[] };
