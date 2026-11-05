import { z } from "zod";
import { mutationSchema } from "../../shared/canvas.js";

export const idSchema = z.string().min(1).max(120);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
export const colorSchema = z.string().max(100).regex(/^(?:#[0-9a-f]{3,8}|[a-z]{1,32}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+\-]+\))$/i);
export const elementFields = {
  x: coordinate, y: coordinate,
  width: z.number().min(0).max(1_000_000), height: z.number().min(0).max(1_000_000),
  angle: z.number().finite().min(-Math.PI * 2).max(Math.PI * 2),
  text: z.string().max(10_000), fontSize: z.number().min(4).max(200),
  fontFamily: z.union([z.number().int().refine(value => [1, 2, 3, 5, 6, 7, 8].includes(value)), z.enum(["virgil", "hand", "handwritten", "helvetica", "sans", "sans-serif", "cascadia", "mono", "monospace", "excalifont", "nunito", "lilita", "comic"])]),
  textAlign: z.enum(["left", "center", "right"]),
  strokeColor: colorSchema, backgroundColor: colorSchema,
  strokeWidth: z.number().min(0).max(20), strokeStyle: z.enum(["solid", "dashed", "dotted"]),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag"]),
  roughness: z.number().min(0).max(3), opacity: z.number().min(0).max(100),
  points: z.array(z.union([z.tuple([coordinate, coordinate]), z.strictObject({ x: coordinate, y: coordinate })])).min(2).max(2000),
  startElementId: idSchema.nullable(), endElementId: idSchema.nullable(),
  startArrowhead: z.enum(["arrow", "bar", "dot", "triangle", "diamond", "circle", "triangle_outline", "dot_outline", "diamond_outline"]).nullable(),
  endArrowhead: z.enum(["arrow", "bar", "dot", "triangle", "diamond", "circle", "triangle_outline", "dot_outline", "diamond_outline"]).nullable(),
  groupIds: z.array(idSchema).max(30), locked: z.boolean(), fileId: idSchema,
};
export const updateElementSchema = z.strictObject(elementFields).partial();
export const createElementSchema = updateElementSchema.extend({
  id: idSchema.optional(), type: z.enum(["rectangle", "ellipse", "diamond", "arrow", "line", "text", "image"]), x: coordinate, y: coordinate,
});
export const operationSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("create"), element: createElementSchema }),
  z.strictObject({ op: z.literal("update"), id: idSchema, changes: updateElementSchema }),
  z.strictObject({ op: z.literal("delete"), id: idSchema }),
]);
export type DrawingOperation = z.infer<typeof operationSchema>;
export const batchSchema = z.array(operationSchema).min(1).max(200);
export const revisionSchema = mutationSchema.shape.expectedRevision;
