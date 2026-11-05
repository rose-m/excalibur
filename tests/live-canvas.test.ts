import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasDocument, Mutation, Scene, SceneUpdate } from "../src/shared/canvas.js";
import type { ServerMessage } from "../src/shared/live.js";
import { LiveCanvas } from "../src/web/live-canvas.js";
import type { LiveRecovery, LiveSocket, LiveStatus } from "../src/web/live-canvas.js";
import type { LiveEditor } from "../src/web/live-state.js";

const white = { viewBackgroundColor: "#fff" };
const black = { viewBackgroundColor: "#000" };
const blue = { viewBackgroundColor: "#00f" };
const red = { viewBackgroundColor: "#f00" };
const blank = (): Scene => ({ elements: [], files: {}, sharedSettings: { ...white } });
const element = { id: "local", type: "rectangle", index: "a0", version: 1, versionNonce: 1, isDeleted: false };

function document(): CanvasDocument {
  return {
    id: "canvas", title: "Test", organizationId: "org", creatorUserId: "owner",
    visibility: "private", revision: 0, createdAt: "now", updatedAt: "now", scene: blank(),
  };
}

class DeferredEditor implements LiveEditor {
  scene = blank();
  pendingSettings: Scene["sharedSettings"][] = [];
  changed = () => {};
  selection: string[] = [];
  selectedElementIds() { return this.selection; }
  read() { return this.scene; }
  normalize(scene: Scene) { return structuredClone(scene); }
  isInvisiblySmall() { return false; }
  render(scene: Scene, replace: boolean) {
    const copy = structuredClone(scene);
    const elements = new Map((replace ? [] : this.scene.elements).map((item) => [item.id, item]));
    for (const item of copy.elements) elements.set(item.id, item);
    this.scene.elements = [...elements.values()];
    this.scene.files = { ...this.scene.files, ...copy.files };
    // Excalidraw replaces scene elements synchronously, but React applies
    // appState later. Tests control when each callback occurs (or is batched).
    this.pendingSettings.push(copy.sharedSettings);
  }
  applyNext() {
    this.scene.sharedSettings = this.pendingSettings.shift()!;
    this.changed();
  }
  applyAll(batched = false) {
    if (batched && this.pendingSettings.length) this.pendingSettings.splice(0, this.pendingSettings.length - 1);
    while (this.pendingSettings.length) this.applyNext();
  }
  localBackground(settings: Scene["sharedSettings"]) {
    this.scene.sharedSettings = { ...settings };
    this.changed();
  }
}

class FakeSocket implements LiveSocket {
  readyState: LiveSocket["readyState"] = 1;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onopen: LiveSocket["onopen"] = null;
  sent: { type: "mutate"; requestId: string; mutation: Mutation }[] = [];
  selections: string[][] = [];
  send(data: Parameters<LiveSocket["send"]>[0]) {
    const message = JSON.parse(data as string);
    if (message.type === "selection") this.selections.push(message.elementIds);
    else this.sent.push(message);
  }
  message(message: ServerMessage) {
    this.onmessage?.call(this as unknown as WebSocket, new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  close() { this.disconnect(1000); }
  disconnect(code = 1006) {
    this.readyState = 3;
    this.onclose?.call(this as unknown as WebSocket, { code } as CloseEvent);
  }
}

function fixture() {
  const canvas = document();
  const editor = new DeferredEditor();
  const sockets: FakeSocket[] = [];
  const statuses: LiveStatus[] = [];
  const clients: LiveCanvas[] = [];
  function create(recovery?: LiveRecovery) {
    const client = new LiveCanvas(canvas, editor, (status) => statuses.push(status), {
      baseUrl: "http://localhost", recovery,
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket; },
    });
    clients.push(client);
    editor.changed = () => client.changed();
    client.connect();
    return client;
  }
  const client = create();
  const socket = sockets[0]!;
  socket.message({ type: "snapshot", canvas });
  editor.applyAll();
  return {
    canvas, editor, sockets, statuses, client, socket, create,
    close: () => { for (const item of clients) item.dispose(); },
  };
}

function update(revision: number, sharedSettings = black): SceneUpdate {
  return { revision, elements: [], files: {}, sharedSettings };
}

test("selection changes publish temporary state without dirtying or mutating the scene", () => {
  const f = fixture();
  try {
    assert.deepEqual(f.socket.selections, [[]], "initial snapshot publishes an empty selection");
    f.editor.selection = ["b", "a", "a"];
    f.client.changed();
    f.client.changed();
    assert.deepEqual(f.socket.selections, [[], ["a", "b"]], "unchanged selections are deduplicated");
    f.client.flush();
    assert.deepEqual(f.socket.sent, []);
    assert.equal(f.client.hasUnsavedChanges(), false);
    assert.equal(f.statuses.at(-1)?.message, "Live · Saved");
    f.editor.selection = [];
    f.client.changed();
    assert.deepEqual(f.socket.selections.at(-1), []);
    f.editor.selection = ["a"];
    const replacement = f.create(f.client.dispose());
    assert.deepEqual(f.sockets[1]!.selections, [], "do not publish before a snapshot");
    f.sockets[1]!.message({ type: "snapshot", canvas: f.canvas });
    assert.deepEqual(f.sockets[1]!.selections, [["a"]], "a new connection republishes current selection");
    replacement.dispose();
    replacement.changed();
    assert.deepEqual(f.sockets[1]!.selections, [["a"]], "disposed clients cannot send selection");
  } finally { f.close(); }
});

test("effect recreation retains unsent scenes and backgrounds across repeated replays", () => {
  const f = fixture();
  try {
    f.editor.scene.elements.push({ ...element });
    f.editor.localBackground(blue);
    let client = f.client;
    for (let replay = 0; replay < 3; replay++) {
      const recovery = client.dispose();
      assert.equal(recovery.unsaved, true);
      // Also simulate the editor itself being recreated before the effect.
      f.editor.scene = blank();
      client = f.create(recovery);
      assert.equal(f.sockets.length, 1, "retained work must block automatic resubscription/replacement");
      assert.deepEqual(f.editor.scene.elements, [element]);
      assert.equal(client.hasUnsavedChanges(), true);
      assert.equal(f.statuses.at(-1)?.ready, false);
      assert.match(f.statuses.at(-1)!.error, /unconfirmed edits/);
      assert.deepEqual(client.dispose().scene.sharedSettings, blue);
      f.editor.applyAll();
      assert.deepEqual(f.editor.scene.sharedSettings, blue);
    }
    f.socket.message({ type: "snapshot", canvas: f.canvas });
    assert.deepEqual(f.editor.scene.elements, [element], "late messages from disposed coordinators cannot overwrite retained work");
  } finally { f.close(); }
});

test("effect recreation treats a committed but unacknowledged mutation as unconfirmed", () => {
  const f = fixture();
  try {
    f.editor.scene.elements.push({ ...element });
    f.client.changed();
    f.client.flush();
    assert.equal(f.socket.sent.length, 1);
    f.socket.message({ type: "update", update: { ...update(1, white), elements: [element] } });
    f.editor.applyAll();
    const recovery = f.client.dispose();
    assert.equal(recovery.unsaved, true, "receiving a broadcast does not replace the missing acknowledgment");
    const replacement = f.create(recovery);
    assert.equal(replacement.hasUnsavedChanges(), true);
    assert.equal(f.sockets.length, 1);
    assert.deepEqual(f.editor.scene.elements, [element]);
  } finally { f.close(); }
});

test("blocked disconnect state survives effect recreation, while clean recreation accepts a new snapshot", () => {
  const dirty = fixture();
  try {
    dirty.editor.scene.elements.push({ ...element });
    dirty.client.changed();
    dirty.socket.disconnect();
    const recovery = dirty.client.dispose();
    const replacement = dirty.create(recovery);
    assert.match(dirty.statuses.at(-1)!.error, /Connection lost with unconfirmed edits/);
    assert.equal(replacement.hasUnsavedChanges(), true);
    assert.equal(dirty.sockets.length, 1);
  } finally { dirty.close(); }

  const clean = fixture();
  try {
    const replacement = clean.create(clean.client.dispose());
    assert.equal(clean.sockets.length, 2);
    clean.sockets[1]!.message({ type: "snapshot", canvas: {
      ...clean.canvas, revision: 1, scene: { ...blank(), elements: [{ ...element, id: "remote" }] },
    } });
    clean.editor.applyAll();
    assert.equal(replacement.hasUnsavedChanges(), false);
    assert.equal(clean.editor.scene.elements[0]?.id, "remote");
    assert.equal(clean.statuses.at(-1)?.ready, true);
  } finally { clean.close(); }
});

test("consecutive remote updates do not classify deferred React background state as a local edit", () => {
  const f = fixture();
  try {
    f.socket.message({ type: "update", update: update(1) });
    f.socket.message({ type: "update", update: update(2) });
    assert.deepEqual(f.editor.scene.sharedSettings, white, "React has not applied either background yet");
    assert.deepEqual(f.editor.pendingSettings, [black, black]);
    f.client.flush();
    assert.equal(f.socket.sent.length, 0);
    assert.equal(f.client.hasUnsavedChanges(), false);
    f.editor.applyAll();
    f.client.flush();
    assert.deepEqual(f.editor.scene.sharedSettings, black);
    assert.equal(f.socket.sent.length, 0, "remote backgrounds must not echo back as mutations");
  } finally { f.close(); }
});

test("batched and intermediate remote background callbacks cannot send an obsolete color", () => {
  for (const batched of [false, true]) {
    const f = fixture();
    try {
      f.socket.message({ type: "update", update: update(1, black) });
      f.socket.message({ type: "update", update: update(2, red) });
      if (!batched) {
        f.editor.applyNext();
        f.client.flush();
        assert.equal(f.socket.sent.length, 0, "the intermediate black render is not local intent");
      }
      f.editor.applyAll(batched);
      f.client.flush();
      assert.deepEqual(f.editor.scene.sharedSettings, red);
      assert.equal(f.socket.sent.length, 0);
      assert.equal(f.client.hasUnsavedChanges(), false);
    } finally { f.close(); }
  }
});

test("genuine local background edits survive remote renders and clear only after commitment", () => {
  const f = fixture();
  try {
    f.socket.message({ type: "update", update: update(1, black) });
    f.editor.localBackground(blue);
    f.socket.message({ type: "update", update: update(2, red) });
    f.editor.applyAll();
    f.client.flush();
    assert.deepEqual(f.editor.scene.sharedSettings, blue);
    assert.deepEqual(f.socket.sent[0]?.mutation.sharedSettings, blue);
    const committed = update(3, blue);
    f.socket.message({ type: "update", update: committed });
    f.socket.message({ type: "ack", requestId: f.socket.sent[0]!.requestId, update: committed });
    f.editor.applyAll();
    f.client.flush();
    assert.equal(f.client.hasUnsavedChanges(), false);
    assert.equal(f.socket.sent.length, 1);
    f.socket.message({ type: "update", update: update(4, red) });
    f.editor.applyAll();
    f.client.flush();
    assert.deepEqual(f.editor.scene.sharedSettings, red, "fulfilled local intent must not override later remote settings");
    assert.equal(f.socket.sent.length, 1);
  } finally { f.close(); }
});

test("a newer local color equal to the old baseline is retained while an older write is in flight", () => {
  const f = fixture();
  try {
    f.editor.localBackground(black);
    f.client.flush();
    f.editor.localBackground(white);
    const committed = update(1, black);
    f.socket.message({ type: "update", update: committed });
    f.socket.message({ type: "ack", requestId: f.socket.sent[0]!.requestId, update: committed });
    f.editor.applyAll();
    f.client.flush();
    assert.equal(f.socket.sent.length, 2);
    assert.deepEqual(f.socket.sent[1]!.mutation.sharedSettings, white);
  } finally { f.close(); }
});
