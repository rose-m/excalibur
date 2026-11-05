import type { CanvasDocument, Scene, SceneUpdate } from "../shared/canvas.js";
import type { ServerMessage } from "../shared/live.js";
import { applyUpdate, pendingMutation, SharedSettingsTracker } from "./live-state.js";
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
  getTicket?: (() => Promise<string>) | undefined;
};

export class LiveCanvas {
  private socket: LiveSocket | undefined;
  private known: Scene;
  private settings: SharedSettingsTracker;
  private revision: number;
  private ready = false;
  private dirty = false;
  private stopped = false;
  private blocked = false;
  private inFlight: string | undefined;
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
          this.known = this.editor.normalize(message.canvas.scene);
          this.settings = new SharedSettingsTracker(this.editor.read().sharedSettings);
          this.revision = message.canvas.revision;
          this.render(this.known, true);
          this.receiveComments(message.comments ?? { revision: 0, comments: [] });
          this.ready = true;
          this.selection = undefined;
          this.sendSelection();
          this.dirty = false;
          this.reconnectDelay = 400;
          this.reconnectAttempts = 0;
          this.status({ ready: true, message: "Live · Saved", error: "" });
        } else if (message.type === "comments") {
          this.receiveComments(message.state);
        } else if (message.type === "update") {
          this.receive(message.update);
        } else if (message.type === "ack") {
          this.receive(message.update);
          if (message.requestId === this.inFlight) {
            clearTimeout(this.acknowledgment);
            this.inFlight = undefined;
            this.settings.settle(this.known.sharedSettings);
            this.schedule();
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

  private scene(): Scene {
    return {
      ...this.editor.read(),
      // Reading React state is not evidence of local intent: it may still be
      // waiting to apply a remote render. Only changed() records local settings.
      sharedSettings: this.settings.value(this.known.sharedSettings),
    };
  }

  private receiveComments(state: CommentState) {
    if (state.revision < this.commentsRevision) return;
    this.commentsRevision = state.revision;
    this.options.onComments?.(state);
  }

  private render(scene: Scene, replace: boolean) {
    this.settings.requested(scene.sharedSettings);
    this.editor.render(scene, replace);
  }

  private receive(update: SceneUpdate) {
    if (!this.ready || update.revision < this.revision) return;
    if (update.revision > this.revision + 1) {
      this.fail("Missed a canvas revision. Export unsaved work, then reload the authoritative scene.");
      return;
    }
    this.known = this.editor.normalize(applyUpdate(this.known, update));
    this.revision = update.revision;
    if (!this.inFlight) this.settings.settle(this.known.sharedSettings);
    this.render({ ...this.known, sharedSettings: this.settings.value(this.known.sharedSettings) }, false);
  }

  changed() {
    if (this.blocked || this.stopped) return;
    this.settings.changed(this.editor.read().sharedSettings, this.ready);
    if (!this.ready) return;
    this.sendSelection();
    if (!this.inFlight) this.settings.settle(this.known.sharedSettings);
    const wasDirty = this.dirty;
    this.dirty = pendingMutation(this.known, this.scene()) !== null;
    if (this.dirty) {
      if (!wasDirty && !this.inFlight) this.status({ ready: true, message: "Live · Unsaved changes", error: "" });
      this.schedule();
    } else if (wasDirty && !this.inFlight) {
      clearTimeout(this.timer);
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
    if (!this.ready || this.blocked || this.stopped) return;
    clearTimeout(this.timer);
    // Let Excalidraw finish applying remote updates before computing a diff.
    this.timer = setTimeout(() => this.flush(), 100);
  }

  flush() {
    if (!this.ready || this.blocked || this.stopped || this.inFlight) return;
    const mutation = pendingMutation(this.known, this.scene());
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
      && typeof element.fileId === "string" && !Object.hasOwn(this.scene().files, element.fileId))) return;
    if (this.socket?.readyState !== 1) return;
    this.inFlight = requestId();
    this.status({ ready: true, message: "Live · Saving…", error: "" });
    try {
      this.socket.send(JSON.stringify({ type: "mutate", requestId: this.inFlight, mutation }));
      this.acknowledgment = setTimeout(() => this.socket?.close(4000, "Acknowledgment timed out"), 15_000);
    } catch { this.fail("Could not send changes. Export unsaved work before reloading."); }
  }

  hasUnsavedChanges() {
    if (this.ready && !this.blocked) this.dirty = pendingMutation(this.known, this.scene()) !== null;
    return this.dirty || this.inFlight !== undefined;
  }

  private fail(message: string) {
    if (this.ready && !this.blocked) this.hasUnsavedChanges();
    this.failure = message;
    this.blocked = true;
    this.ready = false;
    clearTimeout(this.timer);
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
