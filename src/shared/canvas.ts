import { z } from "zod";

export const createCanvasSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
});

// Preserve native fields, including tombstones, bindings and fractional indices.
const elementSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1),
  version: z.number().int().nonnegative(),
  versionNonce: z.number().int(),
  isDeleted: z.boolean(),
  index: z.string().max(200).nullable().optional(),
}).passthrough();

const fileSchema = z.strictObject({
  id: z.string().min(1).max(200),
  mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  dataURL: z.string().max(7_000_000),
  created: z.number().finite().nonnegative(),
});

export const sceneSchema = z.strictObject({
  elements: z.array(elementSchema).max(20_000),
  sharedSettings: z.strictObject({ viewBackgroundColor: z.string().max(100) }),
  files: z.record(z.string().min(1).max(200), fileSchema),
});

export const saveSceneSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  scene: sceneSchema,
});

export const mutationSchema = z.strictObject({
  elements: sceneSchema.shape.elements,
  files: sceneSchema.shape.files.default({}),
  sharedSettings: sceneSchema.shape.sharedSettings.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
});

export type Mutation = z.infer<typeof mutationSchema>;
export type SceneUpdate = {
  revision: number;
  elements: Scene["elements"];
  files: Scene["files"];
  sharedSettings: Scene["sharedSettings"];
};

export type Scene = z.infer<typeof sceneSchema>;
export type SaveScene = z.infer<typeof saveSceneSchema>;
export type CanvasMetadata = {
  id: string;
  organizationId: string;
  creatorUserId: string;
  title: string;
  visibility: "private" | "organization";
  revision: number;
  createdAt: string;
  updatedAt: string;
};
export type CanvasDocument = CanvasMetadata & { scene: Scene };
