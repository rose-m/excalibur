import { CaptureUpdateAction, isInvisiblySmallElement, reconcileElements, restoreElements } from "@excalidraw/excalidraw";
import type { BinaryFiles, ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { CanvasDocument, Scene, SceneUpdate } from "../shared/canvas.js";
import type { ServerMessage } from "../shared/live.js";
import { signature } from "../shared/signature.js";
import { applyUpdate, pendingMutation } from "./live-state.js";

export type LiveStatus = { ready: boolean; message: string; error: string };

function normalize(scene: Scene): Scene {
  const restored = restoreElements(scene.elements as unknown as Parameters<typeof restoreElements>[0], null,
    { refreshDimensions: false, repairBindings: false });
  const byId = new Map(restored.map((element) => [element.id, element]));
  return {
    ...scene,
    // Restoration drops tiny in-progress elements. Keep them in the baseline
    // so an acknowledgment cannot cause an endless resend loop.
    elements: scene.elements.map((element) => byId.get(element.id) ?? element) as Scene["elements"],
  };
}

export class LiveCanvas {
  private socket: WebSocket | undefined;
  private known: Scene;
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

  constructor(private canvas: CanvasDocument, private editor: ExcalidrawImperativeAPI,
    private status: (status: LiveStatus) => void) {
    this.known = normalize(canvas.scene);
    this.revision = canvas.revision;
  }

  connect() {
    if (this.stopped || this.blocked) return;
    this.status({ ready: false, message: "Connecting…", error: "" });
    const url = new URL(`/api/canvases/${this.canvas.id}/live`, window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(url);
    this.socket = socket;
    socket.onmessage = (event) => {
      if (this.stopped || this.blocked || this.socket !== socket) return;
      try {
        const message = JSON.parse(event.data as string) as ServerMessage;
        if (message.type === "snapshot") {
          this.known = normalize(message.canvas.scene);
          this.revision = message.canvas.revision;
          this.render(this.known, true);
          this.ready = true;
          this.dirty = false;
          this.reconnectDelay = 400;
          this.reconnectAttempts = 0;
          this.status({ ready: true, message: "Live · Saved", error: "" });
        } else if (message.type === "update") {
          this.receive(message.update);
        } else if (message.type === "ack") {
          this.receive(message.update);
          if (message.requestId === this.inFlight) {
            clearTimeout(this.acknowledgment);
            this.inFlight = undefined;
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
    const files = this.editor.getFiles();
    return {
      elements: this.editor.getSceneElementsIncludingDeleted() as unknown as Scene["elements"],
      sharedSettings: { viewBackgroundColor: this.editor.getAppState().viewBackgroundColor },
      files: Object.fromEntries(Object.entries(files).map(([id, file]) => [id, {
        id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created,
      }])) as Scene["files"],
    };
  }

  private render(scene: Scene, replace: boolean) {
    // Excalidraw mutates native element objects in place. Never give it our
    // authoritative baseline objects, or local edits would mutate the baseline.
    const remote = structuredClone(scene);
    this.editor.addFiles(Object.values(remote.files) as unknown as BinaryFiles[string][]);
    const elements = replace ? remote.elements : reconcileElements(
      this.editor.getSceneElementsIncludingDeleted() as Parameters<typeof reconcileElements>[0],
      remote.elements as unknown as Parameters<typeof reconcileElements>[1], this.editor.getAppState());
    this.editor.updateScene({
      elements: elements as Parameters<ExcalidrawImperativeAPI["updateScene"]>[0]["elements"],
      appState: scene.sharedSettings,
      // Remote updates must not become local undo steps.
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }

  private receive(update: SceneUpdate) {
    if (!this.ready || update.revision < this.revision) return;
    if (update.revision > this.revision + 1) {
      this.fail("Missed a canvas revision. Export unsaved work, then reload the authoritative scene.");
      return;
    }
    const current = this.scene();
    const localBackground = signature(current.sharedSettings) !== signature(this.known.sharedSettings);
    this.known = normalize(applyUpdate(this.known, update));
    this.revision = update.revision;
    this.render({ ...this.known, sharedSettings: localBackground ? current.sharedSettings : this.known.sharedSettings }, false);
  }

  changed() {
    if (!this.ready || this.blocked || this.stopped) return;
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
      || !isInvisiblySmallElement(element as unknown as Parameters<typeof isInvisiblySmallElement>[0]));
    if (!mutation.elements.length && !Object.keys(mutation.files).length && !mutation.sharedSettings) return;
    // An image can emit an element update before its asynchronous file load.
    if (mutation.elements.some((element) => element.type === "image" && !element.isDeleted
      && typeof element.fileId === "string" && !Object.hasOwn(this.scene().files, element.fileId))) return;
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.inFlight = crypto.randomUUID();
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
    this.blocked = true;
    this.ready = false;
    clearTimeout(this.timer);
    clearTimeout(this.acknowledgment);
    clearTimeout(this.reconnect);
    this.socket?.close();
    this.status({ ready: false, message: "Not synchronized", error: message });
  }

  dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.acknowledgment);
    clearTimeout(this.reconnect);
    const socket = this.socket;
    if (!socket) return;
    socket.onmessage = null;
    socket.onclose = null;
    if (socket.readyState === WebSocket.CONNECTING) socket.onopen = () => socket.close();
    else socket.close();
  }
}
