import { randomUUID } from "node:crypto";
import { createCanvasSchema, saveSceneSchema } from "../../shared/canvas.js";
import type { CanvasDocument, Scene } from "../../shared/canvas.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasRepository } from "../persistence/repository.js";
import { ServiceError } from "./errors.js";

function validateAssets(scene: Scene) {
  let totalBytes = 0;
  const ids = new Set<string>();
  for (const element of scene.elements) {
    if (ids.has(element.id)) throw new ServiceError(400, "Duplicate element ID");
    ids.add(element.id);
    if (element.type === "image" && !element.isDeleted && typeof element.fileId === "string"
      && !Object.hasOwn(scene.files, element.fileId)) {
      throw new ServiceError(400, "Image element is missing its file");
    }
  }
  for (const [id, file] of Object.entries(scene.files)) {
    const prefix = `data:${file.mimeType};base64,`;
    const content = file.dataURL.slice(prefix.length);
    if (id !== file.id || !file.dataURL.startsWith(prefix) || !content.length
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
      throw new ServiceError(400, "Invalid image asset");
    }
    const bytes = Buffer.byteLength(content, "base64");
    totalBytes += bytes;
    if (bytes > 5 * 1024 * 1024 || totalBytes > 15 * 1024 * 1024) {
      throw new ServiceError(413, "Images exceed the 5 MiB per-file or 15 MiB per-canvas limit");
    }
  }
}

export class CanvasService {
  constructor(private repository: CanvasRepository) {}

  list(context: OperationContext) { return this.repository.list(context); }

  create(context: OperationContext, input: unknown): CanvasDocument {
    const { title } = createCanvasSchema.parse(input);
    const now = new Date().toISOString();
    const canvas: CanvasDocument = {
      id: randomUUID(), organizationId: context.organizationId, creatorUserId: context.userId,
      title, visibility: "private", revision: 0, createdAt: now, updatedAt: now,
      scene: { elements: [], sharedSettings: { viewBackgroundColor: "#ffffff" }, files: {} },
    };
    this.repository.create(canvas);
    return canvas;
  }

  get(context: OperationContext, id: string): CanvasDocument {
    const canvas = this.repository.get(id);
    if (!canvas || canvas.organizationId !== context.organizationId
      || (canvas.visibility === "private" && canvas.creatorUserId !== context.userId)) {
      throw new ServiceError(404, "Canvas not found");
    }
    return canvas;
  }

  save(context: OperationContext, id: string, input: unknown) {
    this.get(context, id);
    const parsed = saveSceneSchema.parse(input);
    validateAssets(parsed.scene);
    const canvas = this.repository.commit(id, parsed, new Date().toISOString());
    if (!canvas) throw new ServiceError(409, "Canvas changed elsewhere. Reload before editing again.");
    return canvas;
  }
}
