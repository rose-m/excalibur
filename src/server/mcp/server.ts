import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import type { CallToolResult, JsonSchemaType } from "@modelcontextprotocol/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { changeVisibilitySchema, mutationSchema, sceneSchema } from "../../shared/canvas.js";
import { createCommentSchema } from "../../shared/comments.js";
import { signature } from "../../shared/signature.js";
import type { OperationContext } from "../auth/context.js";
import { DrawingService, activeElement } from "../canvas/drawing.js";
import { createElementSchema, updateElementSchema, batchSchema, idSchema, revisionSchema } from "../canvas/drawing-schema.js";
import type { DrawingOperation } from "../canvas/drawing-schema.js";
import { ServiceError } from "../canvas/errors.js";
import { describeScene } from "../canvas/inspect.js";
import type { CanvasService } from "../canvas/service.js";
import type { HeadlessService } from "../render/client.js";
import { resolveCanvasId, canvasUrl } from "./canvas-reference.js";

const scope = { canvasId: z.string().min(1).max(2048).describe("Explicit canvas UUID or its browser URL returned by create_canvas. Never inferred from a session."), expectedRevision: revisionSchema };
const ids = z.array(idSchema).min(1).max(100);
const renderFields = {
  canvasId: scope.canvasId, format: z.enum(["png", "svg"]).default("png"),
  background: z.boolean().default(true), dark: z.boolean().default(false),
  scale: z.number().min(0.1).max(4).default(1), padding: z.number().min(0).max(200).default(10),
  elementIds: ids.optional(),
};

function result(value: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

export function createCanvasMcpServer(canvases: CanvasService, drawing: DrawingService, headless: HeadlessService, context: OperationContext, publicUrl: string, localOrigins?: ReadonlySet<string>) {
  const server = new McpServer({ name: "excalibur", version: "0.0.0" }, {
    capabilities: { tools: {} },
    instructions: "All canvas tools require an explicit canvasId or application canvas URL. Create a canvas deliberately once, keep its returned ID, and reuse it after reconnects. Drawing helpers generate native Excalidraw elements, labels and bindings. Batch edits commit atomically and publish live updates. Read revision before read–modify–write and pass expectedRevision to reject stale edits. There is no global current canvas. Tools act as the authenticated user within that user's organization; private canvases remain creator-only.",
  });
  function tool<T extends z.ZodType>(name: string, description: string, schema: T,
    run: (args: z.output<T>, signal: AbortSignal) => Promise<CallToolResult> | CallToolResult, readOnly = false, destructive = false) {
    server.registerTool(name, {
      description, inputSchema: fromJsonSchema<Record<string, unknown>>(z.toJSONSchema(schema, { io: "input" }) as unknown as JsonSchemaType),
      annotations: { readOnlyHint: readOnly, destructiveHint: destructive, openWorldHint: false },
    }, async (raw, extra) => {
      try { extra.mcpReq.signal.throwIfAborted(); return await run(schema.parse(raw), extra.mcpReq.signal); }
      catch (error) {
        const status = error instanceof ServiceError ? error.status : error instanceof z.ZodError ? 400 : extra.mcpReq.signal.aborted ? 499 : 500;
        const message = error instanceof ServiceError ? error.message : error instanceof z.ZodError ? error.issues.map(issue => `${issue.path.join(".")}: ${issue.message}`).join("; ") : status === 499 ? "Request cancelled" : "Tool failed";
        return { ...result({ error: { status, message, ...(status === 409 ? { retry: "Read the canvas's latest revision, then retry deliberately." } : {}) } }), isError: true };
      }
    });
  }
  const id = (reference: string) => resolveCanvasId(reference, publicUrl, localOrigins);
  const document = (reference: string) => canvases.get(context, id(reference));
  const withIdentity = (canvasId: string, value: Record<string, unknown>) => result({ canvasId, url: canvasUrl(canvasId, publicUrl), ...value });

  tool("create_canvas", "Create a durable private canvas. Returns its stable ID and browser URL. Do not repeat automatically on reconnect.", z.strictObject({ title: z.string().trim().min(1).max(200) }), args => {
    const canvas = canvases.create(context, args);
    const { scene: _scene, ...metadata } = canvas;
    return withIdentity(canvas.id, metadata);
  });
  tool("list_canvases", "List accessible canvases in the current organization, with stable browser URLs.", z.strictObject({}), () => result({ canvases: canvases.list(context).map(canvas => ({ ...canvas, url: canvasUrl(canvas.id, publicUrl) })) }), true);
  tool("set_canvas_visibility", "Creator only: share this canvas with all current organization members (view and edit), or make it private. Change sharing only when the user explicitly asks. Never public. Read visibility first and pass expectedVisibility; repeat calls for the current visibility are safe. Existing live connections are not forcibly disconnected when made private.", changeVisibilitySchema.extend({ canvasId: scope.canvasId }), args => {
    const canvasId = id(args.canvasId);
    const { canvasId: _canvasId, ...input } = args;
    return withIdentity(canvasId, canvases.setVisibility(context, canvasId, input));
  }, false, true);
  tool("get_canvas", "Reopen/read a canvas by ID or URL. Returns native elements, settings and revision. Image bytes are omitted unless includeFiles is true.", z.strictObject({ canvasId: scope.canvasId, includeFiles: z.boolean().default(false) }), args => {
    const canvas = document(args.canvasId);
    const { scene, ...metadata } = canvas;
    return withIdentity(canvas.id, { ...metadata, elements: scene.elements, sharedSettings: scene.sharedSettings,
      ...(args.includeFiles ? { files: scene.files } : { assets: Object.values(scene.files).map(file => ({ id: file.id, mimeType: file.mimeType })) }) });
  }, true);

  tool("create_element", "Create a native shape, text, line, arrow or stored image. text on a shape/arrow creates a bound label. startElementId/endElementId bind arrows to shapes, including custom IDs created in a batch.", createElementSchema.extend(scope), async (args, signal) => {
    const { canvasId, expectedRevision, ...element } = args;
    const canvas = id(canvasId);
    return withIdentity(canvas, await drawing.edit(context, canvas, [{ op: "create", element }], expectedRevision, signal));
  });
  tool("batch_create_elements", "Create up to 200 elements atomically. Custom IDs let arrows reference shapes in the same batch. Returns generated native labels and binding updates too.", z.strictObject({ ...scope, elements: z.array(createElementSchema).min(1).max(200) }), async (args, signal) => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, await drawing.edit(context, canvas, args.elements.map(element => ({ op: "create", element })), args.expectedRevision, signal));
  });
  tool("update_element", "Patch an existing element without replacing unrelated native fields. Handles text sizing, bound labels and attached arrows. Element type/versions are managed by the service.", updateElementSchema.extend({ ...scope, id: idSchema }), async (args, signal) => {
    const { canvasId, expectedRevision, id: elementId, ...changes } = args;
    const canvas = id(canvasId);
    return withIdentity(canvas, await drawing.edit(context, canvas, [{ op: "update", id: elementId, changes }], expectedRevision, signal));
  });
  tool("delete_element", "Delete an element using a native tombstone. Bound text is deleted and connected arrows are detached atomically.", z.strictObject({ ...scope, id: idSchema }), async (args, signal) => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, await drawing.edit(context, canvas, [{ op: "delete", id: args.id }], args.expectedRevision, signal));
  }, false, true);
  tool("batch_mutate_elements", "Apply mixed create/update/delete operations as one atomic revision. Every operation must succeed. Use this rather than separate calls for coordinated edits.", z.strictObject({ ...scope, operations: batchSchema }), async (args, signal) => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, await drawing.edit(context, canvas, args.operations, args.expectedRevision, signal));
  });
  tool("apply_mutations", "Advanced native-element mutation path, including raster image files. Preserve native versions, nonces, indices and tombstones. Use expectedRevision for read–modify–write.", mutationSchema.extend({ canvasId: scope.canvasId }), args => {
    const { canvasId, ...mutation } = args;
    const canvas = id(canvasId);
    return withIdentity(canvas, canvases.mutate(context, canvas, mutation));
  });

  tool("get_element", "Read one live native element on the selected canvas.", z.strictObject({ canvasId: scope.canvasId, id: idSchema }), args => {
    const canvas = document(args.canvasId);
    return withIdentity(canvas.id, { revision: canvas.revision, element: activeElement(canvas, args.id) });
  }, true);
  tool("get_selected_elements", "Read temporary selections grouped by connected editor tab. Returns each editorId, selected element IDs and their latest committed native data. An empty editors array means no connected editors; an editor with empty elementIds has no saved elements selected. Editor IDs change on reconnect. Unknown, deleted and unsaved elements are omitted. No global current tab is inferred and no image bytes are included.", z.strictObject({ canvasId: scope.canvasId }), args => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, canvases.getSelectedElements(context, canvas));
  }, true);

  tool("get_comments", "Retrieve all unresolved pinned notes on this canvas. Returns commentsRevision (independent of the drawing revision), comment IDs, text, anchors and creation times. Element anchors use normalized u/v coordinates within the unrotated element bounds; their x/y are fallback scene coordinates, not the current position of a moved element. No threads or resolved-comment archive.", z.strictObject({ canvasId: scope.canvasId }), args => {
    const canvas = id(args.canvasId);
    const state = canvases.comments.get(context, canvas);
    return withIdentity(canvas, { commentsRevision: state.revision, comments: state.comments });
  }, true);
  tool("add_comment", "Add a persistent pinned note, visible live in open editors. Supply a canvas anchor for a fixed scene position, or an element anchor to follow a saved element as it moves/resizes/rotates. Text is plain text, at most 4,000 characters. Optionally supply a stable commentId UUID to make retries idempotent. Does not change the drawing revision.", z.strictObject({
    canvasId: scope.canvasId,
    commentId: z.uuid().optional().describe("Optional client-generated UUID. Reuse with identical text/anchor when retrying an uncertain save."),
    text: createCommentSchema.shape.text,
    anchor: createCommentSchema.shape.anchor.describe("Canvas: {type:'canvas',x,y} in scene coordinates. Element: {type:'element',elementId,u,v,x,y}, where u/v are normalized 0..1 within its unrotated bounds and x/y are fallback scene coordinates. The element must exist on this canvas."),
  }), args => {
    const canvas = id(args.canvasId);
    const commentId = args.commentId ?? randomUUID();
    const state = canvases.comments.create(context, canvas, { id: commentId, text: args.text, anchor: args.anchor });
    return withIdentity(canvas, { commentId, commentsRevision: state.revision, comments: state.comments });
  });
  tool("resolve_comment", "Resolve a pinned note by permanently deleting it from this canvas. Open editors update live. Safe to repeat if already absent; comments on other canvases are unaffected. Does not change the drawing revision. There is no resolved-comment archive or undo.", z.strictObject({ canvasId: scope.canvasId, commentId: z.uuid() }), args => {
    const canvas = id(args.canvasId);
    const state = canvases.comments.resolve(context, canvas, args.commentId);
    return withIdentity(canvas, { commentId: args.commentId, commentsRevision: state.revision, comments: state.comments });
  }, false, true);

  tool("query_elements", "Query native elements by type, exact field filters, text substring, or origin coordinate range. Deleted elements are excluded by default.", z.strictObject({ canvasId: scope.canvasId, type: z.string().max(40).optional(), text: z.string().max(1000).optional(), filter: z.record(z.string(), z.unknown()).optional(), includeDeleted: z.boolean().default(false), bbox: z.strictObject({ x_min: z.number().optional(), x_max: z.number().optional(), y_min: z.number().optional(), y_max: z.number().optional() }).optional(), limit: z.number().int().min(1).max(1000).default(100), offset: z.number().int().min(0).default(0) }), args => {
    const canvas = document(args.canvasId);
    const matches = canvas.scene.elements.filter(element => {
      if (!args.includeDeleted && element.isDeleted || args.type && element.type !== args.type) return false;
      if (args.text && !String(element.text ?? "").toLowerCase().includes(args.text.toLowerCase())) return false;
      if (args.filter && Object.entries(args.filter).some(([key, value]) => !Object.hasOwn(element, key) || signature(element[key]) !== signature(value))) return false;
      const box = args.bbox;
      return !box || Number(element.x) >= (box.x_min ?? -Infinity) && Number(element.x) <= (box.x_max ?? Infinity) && Number(element.y) >= (box.y_min ?? -Infinity) && Number(element.y) <= (box.y_max ?? Infinity);
    });
    return withIdentity(canvas.id, { revision: canvas.revision, total: matches.length, elements: matches.slice(args.offset, args.offset + args.limit) });
  }, true);
  tool("get_resource", "Read native document data, not browser-local libraries/theme/viewport. scene includes image bytes; elements returns the element array.", z.strictObject({ canvasId: scope.canvasId, resource: z.enum(["scene", "elements"]) }), args => {
    const canvas = document(args.canvasId);
    return withIdentity(canvas.id, { revision: canvas.revision, resource: args.resource === "elements" ? canvas.scene.elements : { type: "excalidraw", version: 2, source: "excalibur", elements: canvas.scene.elements, appState: canvas.scene.sharedSettings, files: canvas.scene.files } });
  }, true);
  tool("describe_scene", "Describe the canvas's types, positions, text, groups and native arrow connections without needing a browser.", z.strictObject({ canvasId: scope.canvasId }), async (args, signal) => {
    const canvas = document(args.canvasId);
    return withIdentity(canvas.id, { revision: canvas.revision, ...describeScene(canvas.scene, await headless.bounds(canvas.scene.elements, signal)) });
  }, true);

  const selectedWithLabels = (canvasId: string, elementIds: string[]) => {
    const canvas = document(canvasId);
    const selected = new Set(elementIds);
    for (const elementId of selected) activeElement(canvas, elementId);
    for (const element of canvas.scene.elements) if (!element.isDeleted && selected.has(element.containerId as string)) selected.add(element.id);
    return { canvas, selected: [...selected] };
  };
  tool("group_elements", "Group selected elements and bound labels, preserving existing nested groups.", z.strictObject({ ...scope, elementIds: ids }), async (args, signal) => {
    const { canvas, selected } = selectedWithLabels(args.canvasId, args.elementIds);
    const groupId = randomUUID();
    const update = await drawing.transform(context, canvas.id, selected, elements => elements.map(element => ({ op: "update", id: element.id, changes: { groupIds: [...(element.groupIds as string[] ?? []), groupId] } })), args.expectedRevision, signal);
    return withIdentity(canvas.id, { ...update, groupId });
  });
  tool("ungroup_elements", "Remove one named group from its canvas members, without touching other groups.", z.strictObject({ ...scope, groupId: idSchema }), async (args, signal) => {
    const canvas = document(args.canvasId);
    const members = canvas.scene.elements.filter(element => !element.isDeleted && (element.groupIds as string[] | undefined)?.includes(args.groupId));
    if (!members.length) throw new ServiceError(404, "Group not found");
    const update = await drawing.transform(context, canvas.id, members.map(element => element.id), elements => elements.map(element => ({ op: "update", id: element.id, changes: { groupIds: (element.groupIds as string[]).filter(group => group !== args.groupId) } })), args.expectedRevision, signal);
    return withIdentity(canvas.id, update);
  });
  for (const locked of [true, false]) tool(locked ? "lock_elements" : "unlock_elements", `${locked ? "Lock" : "Unlock"} selected elements and their bound labels in the editor. Locking does not change canvas permissions.`, z.strictObject({ ...scope, elementIds: ids }), async (args, signal) => {
    const { canvas, selected } = selectedWithLabels(args.canvasId, args.elementIds);
    return withIdentity(canvas.id, await drawing.transform(context, canvas.id, selected, elements => elements.map(element => ({ op: "update", id: element.id, changes: { locked } })), args.expectedRevision, signal));
  });
  tool("align_elements", "Align selected bounding boxes atomically, moving their labels and rerouting bound arrows.", z.strictObject({ ...scope, elementIds: ids.min(2), alignment: z.enum(["left", "center", "right", "top", "middle", "bottom"]) }), async (args, signal) => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, await drawing.transform(context, canvas, args.elementIds, async elements => {
      const horizontal = ["left", "center", "right"].includes(args.alignment);
      const axis = horizontal ? "x" : "y", size = horizontal ? "width" : "height";
      const bounds = await headless.bounds(elements, signal);
      const boxes = elements.map(element => bounds[element.id]!);
      const fraction = ["left", "top"].includes(args.alignment) ? 0 : ["right", "bottom"].includes(args.alignment) ? 1 : 0.5;
      const edges = boxes.map(box => box[axis] + box[size] * fraction);
      const target = fraction === 0 ? Math.min(...edges) : fraction === 1 ? Math.max(...edges) : edges.reduce((sum, value) => sum + value, 0) / edges.length;
      return elements.map((element, i) => ({ op: "update", id: element.id, changes: { [axis]: Number(element[axis]) + target - edges[i]! } }));
    }, args.expectedRevision, signal));
  });
  tool("distribute_elements", "Distribute at least three elements with equal gaps, keeping the outer bounds fixed. Labels and attached arrows follow.", z.strictObject({ ...scope, elementIds: ids.min(3), direction: z.enum(["horizontal", "vertical"]) }), async (args, signal) => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, await drawing.transform(context, canvas, args.elementIds, async elements => {
      const axis = args.direction === "horizontal" ? "x" : "y", size = axis === "x" ? "width" : "height";
      const bounds = await headless.bounds(elements, signal);
      const sorted = elements.map(element => ({ element, box: bounds[element.id]! })).sort((a, b) => a.box[axis] - b.box[axis]);
      const first = sorted[0]!.box, last = sorted.at(-1)!.box;
      const gap = (last[axis] + last[size] - first[axis] - sorted.reduce((sum, item) => sum + item.box[size], 0)) / (sorted.length - 1);
      let next = first[axis];
      return sorted.map(({ element, box }) => { const value = Number(element[axis]) + next - box[axis]; next += box[size] + gap; return { op: "update", id: element.id, changes: { [axis]: value } } as DrawingOperation; });
    }, args.expectedRevision, signal));
  });
  tool("duplicate_elements", "Duplicate elements, their bound labels and selected frame children. Internal IDs/groups/bindings are remapped; links to unselected originals are detached.", z.strictObject({ ...scope, elementIds: ids, offsetX: z.number().min(-100000).max(100000).default(20), offsetY: z.number().min(-100000).max(100000).default(20) }), args => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, drawing.duplicate(context, canvas, args.elementIds, args.offsetX, args.offsetY, args.expectedRevision));
  });
  tool("clear_canvas", "Clear this canvas using versioned tombstones. Other canvases are untouched. Image bytes remain available for native undo.", z.strictObject(scope), args => {
    const canvas = id(args.canvasId);
    return withIdentity(canvas, drawing.clear(context, canvas, args.expectedRevision));
  }, false, true);

  tool("export_scene", "Return a native .excalidraw JSON document, including image files. No server filesystem paths are accepted.", z.strictObject({ canvasId: scope.canvasId }), args => {
    const canvas = document(args.canvasId);
    return withIdentity(canvas.id, { revision: canvas.revision, scene: { type: "excalidraw", version: 2, source: "excalibur", elements: canvas.scene.elements, appState: canvas.scene.sharedSettings, files: canvas.scene.files } });
  }, true);
  tool("import_scene", "Atomically import native scene data. Merge preserves unrelated elements and gives matching IDs fresh versions; replace tombstones omitted elements and requires expectedRevision. Only background color is retained from appState; browser-local state is ignored. No file paths or URLs.", z.strictObject({ ...scope, mode: z.enum(["merge", "replace"]).default("merge"), scene: z.strictObject({ type: z.literal("excalidraw").optional(), version: z.literal(2).optional(), source: z.string().optional(), elements: sceneSchema.shape.elements, appState: z.object({ viewBackgroundColor: sceneSchema.shape.sharedSettings.shape.viewBackgroundColor.default("#ffffff") }).passthrough().default({ viewBackgroundColor: "#ffffff" }), files: sceneSchema.shape.files.default({}) }) }), args => {
    const canvas = document(args.canvasId);
    drawing.checkRevision(canvas, args.expectedRevision);
    if (args.mode === "replace" && args.expectedRevision === undefined) throw new ServiceError(400, "Replacing a scene requires expectedRevision");
    const existing = new Map(canvas.scene.elements.map(element => [element.id, element]));
    const incomingIds = new Set(args.scene.elements.map(element => element.id));
    const elements = args.scene.elements.map(element => ({ ...element, version: Math.max(element.version, existing.get(element.id)?.version ?? 0) + 1, versionNonce: 0, updated: Date.now() }));
    if (args.mode === "replace") elements.push(...canvas.scene.elements.filter(element => !incomingIds.has(element.id) && !element.isDeleted).map(element => ({ ...element, isDeleted: true, version: element.version + 1, versionNonce: 0, updated: Date.now() })));
    return withIdentity(canvas.id, canvases.mutate(context, canvas.id, { elements, files: args.scene.files, sharedSettings: { viewBackgroundColor: args.scene.appState.viewBackgroundColor }, expectedRevision: canvas.revision }));
  }, false, true);
  for (const name of ["export_to_image", "get_canvas_screenshot"]) tool(name, "Render a canvas or element subset headlessly with the pinned Excalidraw SDK. PNG is returned as MCP image content; SVG as an embedded resource. No open browser is required. Limits: 1,000 elements, 4096px, 8 megapixels, 15 seconds.", z.strictObject(renderFields), async (args, signal) => {
    const canvas = document(args.canvasId);
    const { canvasId: _canvasId, ...options } = args;
    const rendered = await headless.render({ ...options, scene: canvas.scene }, signal);
    const metadata = { canvasId: canvas.id, revision: canvas.revision, format: rendered.format, width: rendered.width, height: rendered.height };
    return { content: [
      { type: "text", text: JSON.stringify(metadata) },
      ...(rendered.format === "png" ? [{ type: "image" as const, mimeType: "image/png", data: rendered.data }] : [{ type: "resource" as const, resource: { uri: `excalibur://canvases/${canvas.id}/render.svg`, mimeType: "image/svg+xml", text: rendered.data } }]),
    ], structuredContent: metadata };
  }, true);
  tool("read_diagram_guide", "Read agent drawing guidance and the canvas-scoped workflow.", z.strictObject({}), () => result({ guide: "Create a canvas once and retain its ID/URL. Use get_canvas/describe_scene to inspect before editing. Start shapes at explicit x/y coordinates; use text for native bound labels. Prefer fontFamily excalifont (5), 20px+ labels, 160x80+ labeled boxes, 60px+ gaps, and a small consistent palette. Assign custom IDs in batch_create_elements, then bind arrows using startElementId/endElementId. Prefer atomic batches and expectedRevision for coordinated read–modify–write. get_canvas_screenshot returns a headless PNG for visual feedback. Query text elements by containerId to inspect generated labels. Deletion uses tombstones; an omitted element is not a deletion. There is no current-canvas state, local filesystem access, public sharing, Mermaid conversion, or named snapshots." }), true);
  return server;
}
