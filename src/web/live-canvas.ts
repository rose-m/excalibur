import type { CanvasDocument, CanvasMetadata, Scene, SceneUpdate } from "../shared/canvas.js";
import type { ServerMessage } from "../shared/live.js";
import { applyUpdate, SceneDiffer, SharedSettingsTracker } from "./live-state.js";
import type { LiveEditor } from "./live-state.js";
import { requestId } from "./request-id.js";
import type { CommentState } from "../shared/comments.js";

export type LiveStatus = { ready: boolean; message: string; error: string };

export type LiveRecovery = { canvasId: string; scene: Scene; unsaved: boolean; error: string };
export type LiveSocket = Pick<WebSocket, "readyState" | "send" | "close" | "onmessage" | "onclose" | "onopen">;
type LiveOptions = {
  baseUrl?: string;
  createSocket?: (url: string) => LiveSocket;
  recovery?: LiveRecovery | undefined;
  onComments?: (state: CommentState) => void;
  onMetadata?: (metadata: CanvasMetadata) => void;
  onDeleted?: () => void;
  getTicket?: (() => Promise<string>) | undefined;
};

const sendInterval = 100;
type SubmittedMutation = {
  revision: number;
  elements: Pick<Scene["elements"][number], "id" | "version" | "versionNonce" | "isDeleted">[];
  files: Scene["files"];
  background: string | undefined;
};

export class LiveCanvas {
  private socket: LiveSocket | undefined;
  private known: Scene;
  private differ: SceneDiffer;
  private settings: SharedSettingsTracker;
  private revision: number;
  private ready = false;
  private dirty = false;
  private stopped = false;
  private blocked = false;
  private inFlight: string | undefined;
  private submitted: SubmittedMutation | undefined;
  // Native finalization can drop unfinished elements instead of tombstoning
  // them. Only track creations this client actually submitted, never omissions
  // of remote elements or drafts which have not left the browser.
  private localCreations = new Map<string, { element: Scene["elements"][number]; version: number }>();
  private removals = new Map<string, Scene["elements"][number]>();
  private lastSentAt: number | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private acknowledgment: ReturnType<typeof setTimeout> | undefined;
  private reconnect: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelay = 400;
  private reconnectAttempts = 0;
  private failure = "";
  private selection: string | undefined;
  private commentsRevision = -1;

  constructor(private canvas: CanvasDocument, private editor: LiveEditor,
    private status: (status: LiveStatus) => void, private options: LiveOptions = {}) {
    this.known = editor.normalize(canvas.scene);
    this.differ = new SceneDiffer(this.known);
    this.settings = new SharedSettingsTracker(editor.read().sharedSettings);
    this.revision = canvas.revision;
  }

  connect() {
    if (this.stopped || this.blocked) return;
    const recovery = this.options.recovery;
    if (recovery?.canvasId === this.canvas.id && (recovery.unsaved || recovery.error)) {
      this.dirty = recovery.unsaved;
      this.settings.retain(recovery.scene.sharedSettings);
      this.render(recovery.scene, true);
      this.fail(recovery.error || "Synchronization restarted with unconfirmed edits. Export your drawing before reloading; edits will not be replaced automatically.");
      return;
    }
    this.status({ ready: false, message: "Connecting…", error: "" });
    if (this.options.getTicket) {
      void this.options.getTicket().then(ticket => {
        if (!this.stopped && !this.blocked) this.openSocket(ticket);
      }).catch(() => { if (!this.stopped && !this.blocked) this.fail("Could not authorize live access. Export unsaved work, then reload to sign in again."); });
    } else this.openSocket();
  }

  private openSocket(ticket?: string) {
    const url = new URL(`/api/canvases/${this.canvas.id}/live`, this.options.baseUrl ?? window.location.href);
    if (ticket) url.searchParams.set("ticket", ticket);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.options.createSocket ? this.options.createSocket(url.href) : new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.stopped || this.blocked || this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "snapshot") {
          this.captureRemovals(this.editor.read());
          if (this.removals.size) {
            this.dirty = true;
            this.fail("Connection lost with an unconfirmed cancellation. Export your drawing before reloading; edits will not be replayed automatically.");
            return;
          }
          this.localCreations.clear();
          this.removals.clear();
          this.known = this.editor.normalize(message.canvas.scene);
          this.differ = new SceneDiffer(this.known);
          this.settings = new SharedSettingsTracker(this.editor.read().sharedSettings);
          this.revision = message.canvas.revision;
          this.render(this.known, true);
          this.receiveComments(message.comments ?? { revision: 0, comments: [] });
          const { scene: _scene, ...metadata } = message.canvas;
          this.options.onMetadata?.(metadata);
          this.ready = true;
          this.selection = undefined;
          this.sendSelection();
          this.dirty = false;
          this.reconnectDelay = 400;
          this.reconnectAttempts = 0;
          this.lastSentAt = undefined;
          this.status({ ready: true, message: "Live · Saved", error: "" });
        } else if (message.type === "comments") {
          this.receiveComments(message.state);
        } else if (message.type === "metadata") {
          this.options.onMetadata?.(message.metadata);
        } else if (message.type === "deleted") {
          this.fail("This canvas was deleted. Export any unsaved drawing before returning to your canvases.");
          this.options.onDeleted?.();
        } else if (message.type === "update") {
          this.receive(message.update);
        } else if (message.type === "ack") {
          // A committed mutation is normally broadcast before its ack. Do not
          // normalize/clone/render it twice, but still apply rejected/no-op input
          // corrections even when they carry the current revision.
          if (message.requestId !== this.inFlight || !this.alreadyApplied(message.update)) this.receive(message.update, true);
          if (message.requestId === this.inFlight) {
            clearTimeout(this.acknowledgment);
            this.inFlight = undefined;
            this.submitted = undefined;
            this.settings.settle(this.known.sharedSettings);
            this.dirty = this.differ.hasChanges(this.scene());
            if (this.dirty) this.schedule();
            else if (this.ready) this.status({ ready: true, message: "Live · Saved", error: "" });
          }
        } else if (message.type === "error") {
          this.fail(message.message);
        } else {
          this.fail("Unexpected collaboration message. Reload the canvas.");
        }
      } catch { this.fail("Could not synchronize the scene. Export unsaved work, then reload."); }
    };
    socket.onclose = (event) => {
      if (this.stopped || this.blocked || this.socket !== socket) return;
      const unsaved = this.hasUnsavedChanges();
      this.ready = false;
      clearTimeout(this.timer);
      this.timer = undefined;
      clearTimeout(this.acknowledgment);
      if (unsaved) {
        this.fail("Connection lost with unconfirmed edits. Export your drawing before reloading; edits will not be replayed automatically.");
      } else if (event.code === 1008) {
        this.fail("Canvas access is no longer available. Reload to check access.");
      } else if (++this.reconnectAttempts > 5) {
        this.fail("Could not reconnect to the canvas. Reload to check the server and canvas access.");
      } else {
        this.status({ ready: false, message: "Reconnecting…", error: "" });
        this.reconnect = setTimeout(() => this.connect(), this.reconnectDelay);
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 5000);
      }
    };
  }

  private scene(current = this.editor.read()): Scene {
    this.captureRemovals(current);
    return this.withRemovals({
      ...current,
      // Reading React state is not evidence of local intent: it may still be
      // waiting to apply a remote render. Only changed() records local settings.
      sharedSettings: this.settings.value(this.known.sharedSettings),
    });
  }

  private captureRemovals(scene: Scene) {
    if (!this.localCreations.size) return;
    const current = new Map(scene.elements.map(element => [element.id, element]));
    let known: Map<string, Scene["elements"][number]> | undefined;
    for (const [id, creation] of this.localCreations) {
      const element = current.get(id);
      if (element) {
        creation.element = element;
        creation.version = Math.max(creation.version, element.version);
        const removal = this.removals.get(id);
        // A newer native undo/recreation supersedes our pending cancellation.
        if (removal && !element.isDeleted && element.version > removal.version) this.removals.delete(id);
      } else if (!this.removals.has(id)) {
        known ??= new Map(this.known.elements.map(element => [element.id, element]));
        const committed = known.get(id);
        const version = Math.max(creation.version, creation.element.version);
        // A same-version deletion can still lose to a live creation already in
        // flight (nonce tie-break). Keep cancellation intent until it is newer.
        if (committed?.isDeleted && committed.version > version) { this.localCreations.delete(id); continue; }
        this.removals.set(id, {
          ...structuredClone(creation.element), isDeleted: true,
          version: Math.max(version, committed?.version ?? 0) + 1,
          versionNonce: 0, updated: Date.now(),
        });
      }
    }
  }

  private withRemovals(scene: Scene): Scene {
    if (!this.removals.size) return scene;
    const ids = new Set(scene.elements.map(element => element.id));
    return { ...scene, elements: [
      ...scene.elements.map(element => this.removals.get(element.id) ?? element),
      ...[...this.removals.values()].filter(element => !ids.has(element.id)),
    ] };
  }

  private settleRemovals() {
    if (!this.localCreations.size) return;
    for (const element of this.known.elements) {
      const creation = this.localCreations.get(element.id);
      if (!creation) continue;
      const removal = this.removals.get(element.id);
      const deleted = removal ? element.version >= removal.version
        : element.version > Math.max(creation.version, creation.element.version);
      if (element.isDeleted && deleted) {
        this.removals.delete(element.id);
        this.localCreations.delete(element.id);
      } else if (removal && element.version >= removal.version) {
        // Do not let an intervening committed edit resurrect a canceled draft.
        this.removals.set(element.id, { ...removal, version: element.version + 1 });
      }
    }
  }

  private receiveComments(state: CommentState) {
    if (state.revision < this.commentsRevision) return;
    this.commentsRevision = state.revision;
    this.options.onComments?.(state);
  }

  private render(scene: Scene, replace: boolean) {
    this.settings.requested(scene.sharedSettings);
    this.editor.render(this.withRemovals(scene), replace);
    // Elements update synchronously even when React defers the appState callback.
    this.captureRemovals(this.editor.read());
  }

  private alreadyApplied(update: SceneUpdate) {
    const submitted = this.submitted;
    if (!submitted || update.revision !== this.revision || update.revision <= submitted.revision) return false;
    const elements = new Map(update.elements.map(element => [element.id, element]));
    return submitted.elements.every(element => {
      const committed = elements.get(element.id);
      return committed && committed.version === element.version && committed.versionNonce === element.versionNonce
        && committed.isDeleted === element.isDeleted;
    }) && Object.entries(submitted.files).every(([id, file]) => {
      const committed = Object.hasOwn(update.files, id) ? update.files[id] : undefined;
      return committed && committed.mimeType === file.mimeType && committed.dataURL === file.dataURL;
    }) && (submitted.background === undefined || submitted.background === update.sharedSettings.viewBackgroundColor);
  }

  private receive(update: SceneUpdate, allowSameRevision = false) {
    if (!this.ready || update.revision < this.revision || (!allowSameRevision && update.revision === this.revision)) return;
    if (update.revision > this.revision + 1) {
      this.fail("Missed a canvas revision. Export unsaved work, then reload the authoritative scene.");
      return;
    }
    // Observe cancellations before a broadcast/ack can restore the missing draft.
    this.captureRemovals(this.editor.read());
    this.known = this.editor.normalize(applyUpdate(this.known, update));
    this.settleRemovals();
    this.differ = new SceneDiffer(this.known);
    this.revision = update.revision;
    if (!this.inFlight) this.settings.settle(this.known.sharedSettings);
    this.render({ ...this.known, sharedSettings: this.settings.value(this.known.sharedSettings) }, false);
    if (this.removals.size) { this.dirty = true; this.schedule(); }
  }

  changed() {
    if (this.blocked || this.stopped) return;
    const current = this.editor.read();
    this.settings.changed(current.sharedSettings, this.ready);
    if (!this.ready) {
      this.captureRemovals(current);
      if (this.removals.size) {
        this.dirty = true;
        this.fail("Connection lost with an unconfirmed cancellation. Export your drawing before reloading; edits will not be replayed automatically.");
      }
      return;
    }
    this.sendSelection();
    if (!this.inFlight) this.settings.settle(this.known.sharedSettings);
    const wasDirty = this.dirty;
    this.dirty = this.differ.hasChanges(this.scene(current));
    if (this.dirty) {
      if (!wasDirty && !this.inFlight) this.status({ ready: true, message: "Live · Unsaved changes", error: "" });
      this.schedule();
    } else if (wasDirty && !this.inFlight) {
      clearTimeout(this.timer);
      this.timer = undefined;
      this.status({ ready: true, message: "Live · Saved", error: "" });
    }
  }

  private sendSelection() {
    if (!this.ready || this.stopped || this.blocked || this.socket?.readyState !== 1) return;
    const elementIds = [...new Set(this.editor.selectedElementIds())].sort();
    const selection = JSON.stringify(elementIds);
    if (selection === this.selection) return;
    try {
      this.socket.send(JSON.stringify({ type: "selection", elementIds }));
      this.selection = selection;
    } catch { this.socket.close(4000, "Could not send selection"); }
  }

  private schedule() {
    if (!this.ready || this.blocked || this.stopped || this.inFlight || this.timer !== undefined) return;
    // Keep the existing deadline during continuous input. Acks provide
    // backpressure; sending resumes once both the interval and ack have elapsed.
    const delay = this.lastSentAt === undefined ? sendInterval : Math.max(0, sendInterval - (Date.now() - this.lastSentAt));
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, delay);
  }

  flush() {
    if (!this.ready || this.blocked || this.stopped || this.inFlight) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const scene = this.scene();
    const mutation = this.differ.mutation(scene);
    this.dirty = mutation !== null;
    if (!mutation) {
      this.status({ ready: true, message: "Live · Saved", error: "" });
      return;
    }
    const knownIds = new Set(this.known.elements.map((element) => element.id));
    mutation.elements = mutation.elements.filter((element) => element.isDeleted || knownIds.has(element.id)
      || !this.editor.isInvisiblySmall(element));
    if (!mutation.elements.length && !Object.keys(mutation.files).length && !mutation.sharedSettings) return;
    // An image can emit an element update before its asynchronous file load.
    if (mutation.elements.some((element) => element.type === "image" && !element.isDeleted
      && typeof element.fileId === "string" && !Object.hasOwn(scene.files, element.fileId))) return;
    if (this.socket?.readyState !== 1) return;
    for (const element of mutation.elements) {
      const creation = this.localCreations.get(element.id);
      if (creation) {
        creation.element = element;
        creation.version = Math.max(creation.version, element.version);
      } else if (!knownIds.has(element.id) && !element.isDeleted) {
        this.localCreations.set(element.id, { element, version: element.version });
      }
    }
    this.inFlight = requestId();
    this.submitted = {
      revision: this.revision,
      elements: mutation.elements.map(({ id, version, versionNonce, isDeleted }) => ({ id, version, versionNonce, isDeleted })),
      files: Object.fromEntries(Object.entries(mutation.files).map(([id, file]) => [id, { ...file }])),
      background: mutation.sharedSettings?.viewBackgroundColor,
    };
    this.status({ ready: true, message: "Live · Saving…", error: "" });
    try {
      this.socket.send(JSON.stringify({ type: "mutate", requestId: this.inFlight, mutation }));
      this.lastSentAt = Date.now();
      this.acknowledgment = setTimeout(() => this.socket?.close(4000, "Acknowledgment timed out"), 15_000);
    } catch { this.fail("Could not send changes. Export unsaved work before reloading."); }
  }

  hasUnsavedChanges() {
    if (this.ready && !this.blocked) this.dirty = this.differ.mutation(this.scene()) !== null;
    return this.dirty || this.inFlight !== undefined;
  }

  private fail(message: string) {
    if (this.ready && !this.blocked) this.hasUnsavedChanges();
    this.failure = message;
    this.blocked = true;
    this.ready = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.acknowledgment);
    clearTimeout(this.reconnect);
    this.socket?.close();
    this.status({ ready: false, message: "Not synchronized", error: message });
  }

  dispose(): LiveRecovery {
    const recovery: LiveRecovery = {
      canvasId: this.canvas.id, scene: structuredClone(this.scene()),
      unsaved: this.hasUnsavedChanges(), error: this.failure,
    };
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    clearTimeout(this.acknowledgment);
    clearTimeout(this.reconnect);
    const socket = this.socket;
    if (socket) {
      socket.onmessage = null;
      socket.onclose = null;
      if (socket.readyState === 0) socket.onopen = () => socket.close();
      else socket.close();
    }
    return recovery;
  }
}
