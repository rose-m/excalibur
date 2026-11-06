import { randomUUID } from "node:crypto";
import { changeVisibilitySchema, createCanvasSchema, deleteCanvasSchema, mutationSchema, renameCanvasSchema, saveSceneSchema, sceneSchema } from "../../shared/canvas.js";
import type { CanvasDocument, CanvasMetadata, Scene, SceneUpdate } from "../../shared/canvas.js";
import { signature } from "../../shared/signature.js";
import { selectedElementIdsSchema } from "../../shared/live.js";
import type { OperationContext } from "../auth/context.js";
import type { CanvasRepository } from "../persistence/repository.js";
import { ServiceError } from "./errors.js";
import { reconcileElements } from "./reconcile.js";
import { CommentService } from "./comments.js";

function validateAssets(scene: Scene) {
  if (Buffer.byteLength(JSON.stringify(scene)) > 24 * 1024 * 1024) {
    throw new ServiceError(413, "Scene exceeds the 24 MiB canvas limit");
  }
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
  private listeners = new Map<string, Set<(update: SceneUpdate) => void>>();
  private metadataListeners = new Map<string, Set<(metadata: CanvasMetadata) => void>>();
  private deletionListeners = new Map<string, Set<() => void>>();
  // Socket-scoped editor state. Never committed, versioned or broadcast as a
  // scene mutation. New connections (including reconnects) get fresh IDs.
  private editors = new Map<string, Map<string, string[]>>();
  readonly comments: CommentService;
  constructor(private repository: CanvasRepository) {
    this.comments = new CommentService(repository, (context, id) => this.get(context, id));
  }

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

  setVisibility(context: OperationContext, id: string, input: unknown): CanvasMetadata {
    const current = this.get(context, id);
    if (current.creatorUserId !== context.userId) throw new ServiceError(403, "Only the canvas creator can change sharing");
    const { visibility, expectedVisibility } = changeVisibilitySchema.parse(input);
    if (current.visibility === visibility) {
      const { scene: _scene, ...metadata } = current;
      return metadata;
    }
    if (current.visibility !== expectedVisibility) throw new ServiceError(409, "Sharing changed. Review the current visibility and try again.");
    const metadata = this.repository.setVisibility(id, visibility, current.revision, new Date().toISOString());
    if (!metadata) throw new ServiceError(409, "Canvas revision changed. Read the latest canvas and retry.");
    this.publishMetadata(metadata, current.scene.sharedSettings);
    return metadata;
  }

  rename(context: OperationContext, id: string, input: unknown): CanvasMetadata {
    const current = this.get(context, id);
    if (current.creatorUserId !== context.userId) throw new ServiceError(403, "Only the canvas creator can rename it");
    const { title, expectedTitle } = renameCanvasSchema.parse(input);
    if (current.title === title) {
      const { scene: _scene, ...metadata } = current;
      return metadata;
    }
    if (current.title !== expectedTitle) throw new ServiceError(409, "Canvas name changed. Review the current name and try again.");
    const metadata = this.repository.rename(id, title, current.revision, new Date().toISOString());
    if (!metadata) throw new ServiceError(409, "Canvas changed. Read the latest canvas and retry.");
    this.publishMetadata(metadata, current.scene.sharedSettings);
    return metadata;
  }

  delete(context: OperationContext, id: string, input: unknown) {
    const current = this.get(context, id);
    if (current.creatorUserId !== context.userId) throw new ServiceError(403, "Only the canvas creator can delete it");
    const { confirmTitle, expectedRevision } = deleteCanvasSchema.parse(input);
    if (current.title !== confirmTitle || current.revision !== expectedRevision) throw new ServiceError(409, "Canvas changed. Review the latest canvas and confirm deletion again.");
    if (!this.repository.delete(id, expectedRevision)) throw new ServiceError(409, "Canvas changed. Review the latest canvas and confirm deletion again.");
    // Notify only after the cascade commits. Subscriber failures must not report
    // failure for a deletion which has already removed the durable data.
    for (const listener of [...(this.deletionListeners.get(id) ?? [])]) {
      try { listener(); } catch { console.error("Canvas deletion subscriber failed"); }
    }
    this.deletionListeners.delete(id);
    this.listeners.delete(id);
    this.metadataListeners.delete(id);
    this.editors.delete(id);
    this.comments.forgetCanvas(id);
    return { canvasId: id, deleted: true as const };
  }

  private publishMetadata(metadata: CanvasMetadata, sharedSettings: Scene["sharedSettings"]) {
    // Metadata advances the canvas revision without changing the scene. Send an
    // empty scene update first so live editors cannot miss a revision.
    const id = metadata.id;
    const update = { revision: metadata.revision, elements: [], files: {}, sharedSettings };
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(update); } catch { console.error("Canvas update subscriber failed"); }
    }
    for (const listener of this.metadataListeners.get(id) ?? []) {
      try { listener(metadata); } catch { console.error("Canvas metadata subscriber failed"); }
    }
  }

  subscribeDeletion(context: OperationContext, id: string, listener: () => void): () => void {
    this.get(context, id);
    let listeners = this.deletionListeners.get(id);
    if (!listeners) { listeners = new Set(); this.deletionListeners.set(id, listeners); }
    listeners.add(listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      listeners.delete(listener);
      if (!listeners.size && this.deletionListeners.get(id) === listeners) this.deletionListeners.delete(id);
    };
  }

  subscribeMetadata(context: OperationContext, id: string, listener: (metadata: CanvasMetadata) => void): () => void {
    this.get(context, id);
    let listeners = this.metadataListeners.get(id);
    if (!listeners) { listeners = new Set(); this.metadataListeners.set(id, listeners); }
    listeners.add(listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      listeners.delete(listener);
      if (!listeners.size && this.metadataListeners.get(id) === listeners) this.metadataListeners.delete(id);
    };
  }

  save(context: OperationContext, id: string, input: unknown) {
    this.get(context, id);
    const parsed = saveSceneSchema.parse(input);
    // Compatibility snapshot-shaped input still reconciles elements; omission
    // never deletes another participant's work. Deletions require tombstones.
    this.mutate(context, id, { ...parsed.scene, expectedRevision: parsed.expectedRevision });
    const { scene: _scene, ...metadata } = this.get(context, id);
    return metadata;
  }

  mutate(context: OperationContext, id: string, input: unknown): SceneUpdate {
    // This read–reconcile–commit sequence is synchronous and cannot interleave
    // within this process. Async persistence requires per-canvas serialization.
    const current = this.get(context, id);
    const mutation = mutationSchema.parse(input);
    if (mutation.expectedRevision !== undefined && mutation.expectedRevision !== current.revision) {
      throw new ServiceError(409, "Canvas revision changed. Read the latest scene and retry.");
    }
    for (const [key, file] of Object.entries(mutation.files)) {
      const existing = Object.hasOwn(current.scene.files, key) ? current.scene.files[key] : undefined;
      if (existing && (existing.mimeType !== file.mimeType || existing.dataURL !== file.dataURL)) {
        throw new ServiceError(409, "An image asset ID cannot be reused for different content");
      }
      if (existing) mutation.files[key] = existing;
    }
    const scene = sceneSchema.parse({
      elements: reconcileElements(current.scene.elements, mutation.elements),
      sharedSettings: mutation.sharedSettings ?? current.scene.sharedSettings,
      files: { ...current.scene.files, ...mutation.files },
    });
    validateAssets(scene);
    const submitted = new Set(mutation.elements.map((element) => element.id));
    const previous = new Map(current.scene.elements.map((element) => [element.id, signature(element)]));
    const update: SceneUpdate = {
      revision: current.revision,
      elements: scene.elements.filter((element) => submitted.has(element.id) || previous.get(element.id) !== signature(element)),
      files: mutation.files,
      sharedSettings: scene.sharedSettings,
    };
    if (signature(scene) === signature(current.scene)) return update;

    const committed = this.repository.commit(id, { expectedRevision: current.revision, scene }, new Date().toISOString());
    if (!committed) throw new ServiceError(409, "Canvas revision changed. Read the latest scene and retry.");
    update.revision = committed.revision;
    // Only committed state is observable. A subscriber failure cannot undo or
    // report failure for a transaction which has already committed.
    for (const listener of this.listeners.get(id) ?? []) {
      try { listener(update); }
      catch { console.error("Canvas update subscriber failed"); }
    }
    return update;
  }

  subscribe(context: OperationContext, id: string, listener: (update: SceneUpdate) => void): () => void {
    this.get(context, id);
    let listeners = this.listeners.get(id);
    if (!listeners) { listeners = new Set(); this.listeners.set(id, listeners); }
    listeners.add(listener);
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      listeners.delete(listener);
      if (!listeners.size && this.listeners.get(id) === listeners) this.listeners.delete(id);
    };
  }

  connectEditor(context: OperationContext, id: string) {
    this.get(context, id);
    let editors = this.editors.get(id);
    if (!editors) { editors = new Map(); this.editors.set(id, editors); }
    const editorId = randomUUID();
    editors.set(editorId, []);
    let closed = false;
    return {
      setSelection: (input: unknown) => {
        if (closed) return;
        this.get(context, id);
        editors.set(editorId, [...new Set(selectedElementIdsSchema.parse(input))]);
      },
      close: () => {
        if (closed) return;
        closed = true;
        editors.delete(editorId);
        if (!editors.size && this.editors.get(id) === editors) this.editors.delete(id);
      },
    };
  }

  getSelectedElements(context: OperationContext, id: string) {
    const canvas = this.get(context, id);
    const active = new Map(canvas.scene.elements.filter(element => !element.isDeleted).map(element => [element.id, element]));
    return {
      revision: canvas.revision,
      editors: [...(this.editors.get(id) ?? [])].map(([editorId, ids]) => {
        // Resolve against the current committed scene, not an old element copy.
        // Deleted, foreign and not-yet-saved elements are never returned.
        const elements = ids.flatMap(elementId => { const element = active.get(elementId); return element ? [element] : []; });
        return { editorId, elementIds: elements.map(element => element.id), elements };
      }),
    };
  }
}
