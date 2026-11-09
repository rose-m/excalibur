import assert from "node:assert/strict";
import { test } from "node:test";
import type { CanvasDocument, CanvasMetadata, Mutation, Scene, SceneUpdate } from "../src/shared/canvas.js";
import type { ServerMessage } from "../src/shared/live.js";
import { LiveCanvas } from "../src/web/live-canvas.js";
import type { LiveRecovery, LiveSocket, LiveStatus } from "../src/web/live-canvas.js";
import type { LiveEditor } from "../src/web/live-state.js";
import type { CommentState } from "../src/shared/comments.js";
import { reconcileElements } from "../src/server/canvas/reconcile.js";

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
  activeElements = new Set<string>();
  selectedElementIds() { return this.selection; }
  read() { return this.scene; }
  normalize(scene: Scene) { return structuredClone(scene); }
  isInvisiblySmall() { return false; }
  render(scene: Scene, replace: boolean) {
    const copy = structuredClone(scene);
    const elements = new Map((replace ? [] : this.scene.elements).map((item) => [item.id, item]));
    for (const item of copy.elements) {
      const local = elements.get(item.id);
      // Match native reconciliation's active-editor and version exemptions.
      if (local && !replace && (this.activeElements.has(item.id) || local.version > item.version
        || (local.version === item.version && local.versionNonce < item.versionNonce))) continue;
      elements.set(item.id, item);
    }
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
  const comments: CommentState[] = [];
  const metadata: CanvasMetadata[] = [];
  let deletions = 0;
  const clients: LiveCanvas[] = [];
  function create(recovery?: LiveRecovery) {
    const client = new LiveCanvas(canvas, editor, (status) => statuses.push(status), {
      baseUrl: "http://localhost", recovery,
      onComments: state => comments.push(state),
      onMetadata: value => metadata.push(value),
      onDeleted: () => { deletions++; },
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
    canvas, editor, sockets, statuses, comments, metadata, client, socket, create, deletions: () => deletions,
    close: () => { for (const item of clients) item.dispose(); },
  };
}

function update(revision: number, sharedSettings = black): SceneUpdate {
  return { revision, elements: [], files: {}, sharedSettings };
}

function authoritativeScene() {
  let scene = blank();
  let revision = 0;
  return {
    read: () => scene,
    commit(mutation: Mutation): SceneUpdate {
      scene = {
        elements: reconcileElements(scene.elements, mutation.elements),
        files: { ...scene.files, ...mutation.files },
        sharedSettings: mutation.sharedSettings ?? scene.sharedSettings,
      };
      return { ...scene, revision: ++revision };
    },
  };
}

test("sharing metadata and empty revision updates do not dirty or interrupt the live editor", () => {
  const f = fixture();
  try {
    assert.equal(f.metadata[0]?.visibility, "private");
    f.socket.message({ type: "update", update: update(1, white) });
    const { scene: _scene, ...metadata } = f.canvas;
    f.socket.message({ type: "metadata", metadata: { ...metadata, visibility: "organization", revision: 1 } });
    f.editor.applyAll();
    assert.equal(f.metadata.at(-1)?.visibility, "organization");
    assert.equal(f.client.hasUnsavedChanges(), false);
    f.socket.message({ type: "update", update: { ...update(2, white), elements: [element] } });
    f.editor.applyAll();
    assert.equal(f.editor.scene.elements[0]?.id, element.id);
    assert.equal(f.statuses.at(-1)?.ready, true);
    assert.equal(f.socket.sent.length, 0);
  } finally { f.close(); }
});

test("remote deletion stops writes and reconnects while retaining unsaved work for export", () => {
  const f = fixture();
  try {
    f.editor.scene.elements = [element];
    f.client.changed();
    f.socket.message({ type: "deleted", canvasId: f.canvas.id });
    assert.equal(f.deletions(), 1);
    assert.equal(f.statuses.at(-1)?.ready, false);
    assert.match(f.statuses.at(-1)?.error ?? "", /deleted.*Export/);
    assert.equal(f.client.hasUnsavedChanges(), true);
    assert.equal(f.editor.scene.elements[0]?.id, element.id);
    f.client.flush();
    f.client.connect();
    assert.equal(f.socket.sent.length, 0);
    assert.equal(f.sockets.length, 1);
  } finally { f.close(); }
});

test("ticket authentication waits before opening and fetches a fresh ticket on reconnect", async () => {
  const canvas = document();
  const editor = new DeferredEditor();
  const sockets: FakeSocket[] = [];
  const urls: string[] = [];
  let issues = 0;
  const client = new LiveCanvas(canvas, editor, () => {}, {
    baseUrl: "https://app.example",
    getTicket: async () => `ticket-${++issues}`,
    createSocket: url => { urls.push(url); const socket = new FakeSocket(); sockets.push(socket); return socket; },
  });
  try {
    client.connect();
    assert.equal(sockets.length, 0, "a socket must not open before authorization completes");
    await Promise.resolve();
    assert.equal(new URL(urls[0]!).protocol, "wss:");
    assert.equal(new URL(urls[0]!).searchParams.get("ticket"), "ticket-1");
    sockets[0]!.message({ type: "snapshot", canvas });
    editor.applyAll();
    sockets[0]!.disconnect();
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(issues, 2);
    assert.equal(new URL(urls[1]!).searchParams.get("ticket"), "ticket-2");
  } finally { client.dispose(); }
});

test("disposing during ticket issuance prevents a late socket; auth failures never open one", async () => {
  let resolveTicket!: (ticket: string) => void;
  let sockets = 0;
  const statuses: LiveStatus[] = [];
  const options = {
    baseUrl: "https://app.example",
    getTicket: () => new Promise<string>(resolve => { resolveTicket = resolve; }),
    createSocket: () => { sockets++; return new FakeSocket(); },
  };
  const client = new LiveCanvas(document(), new DeferredEditor(), status => statuses.push(status), options);
  client.connect();
  client.dispose();
  resolveTicket("late");
  await Promise.resolve();
  assert.equal(sockets, 0);
  const denied = new LiveCanvas(document(), new DeferredEditor(), status => statuses.push(status), {
    ...options, getTicket: async () => { throw new Error("Unauthorized"); },
  });
  denied.connect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sockets, 0);
  assert.match(statuses.at(-1)!.error, /authorize live access/);
  denied.dispose();
});

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

test("comment broadcasts are separate from scene revisions and ignore stale comment snapshots", () => {
  const f = fixture();
  try {
    f.socket.message({ type: "comments", state: { revision: 2, comments: [] } });
    f.socket.message({ type: "comments", state: { revision: 1, comments: [] } });
    assert.deepEqual(f.comments.map(state => state.revision), [0, 2]);
    f.socket.message({ type: "update", update: update(1, white) });
    f.editor.applyAll();
    f.client.flush();
    assert.deepEqual(f.socket.sent, []);
    assert.equal(f.client.hasUnsavedChanges(), false);
    assert.equal(f.statuses.at(-1)?.ready, true);
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

test("continuous drawing sends at bounded intervals and flushes the final edit without another callback", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const f = fixture();
  try {
    const sentAt: number[] = [];
    const send = f.socket.send.bind(f.socket);
    t.mock.method(f.socket, "send", (data: Parameters<LiveSocket["send"]>[0]) => {
      if (JSON.parse(data as string).type === "mutate") sentAt.push(Date.now());
      send(data);
    });
    let acknowledged = 0;
    for (let version = 1; version <= 15; version++) {
      f.editor.scene.elements = [{ ...element, version }];
      f.client.changed();
      t.mock.timers.tick(20);
      if (f.socket.sent.length > acknowledged) {
        const packet = f.socket.sent.at(-1)!;
        const committed = { ...update(++acknowledged, white), elements: packet.mutation.elements };
        f.socket.message({ type: "update", update: committed });
        f.socket.message({ type: "ack", requestId: packet.requestId, update: committed });
        f.editor.applyAll();
      }
    }
    assert.deepEqual(sentAt, [1100, 1200, 1300], "continuous callbacks must not reset the send deadline");
    assert.equal(f.socket.sent.at(-1)!.mutation.elements[0]!.version, 15);
    t.mock.timers.tick(10);
    f.editor.scene.elements = [{ ...element, version: 16 }];
    f.client.changed();
    t.mock.timers.tick(89);
    assert.equal(f.socket.sent.length, 3);
    t.mock.timers.tick(1);
    assert.equal(f.socket.sent.length, 4);
    assert.equal(f.socket.sent[3]!.mutation.elements[0]!.version, 16);
  } finally { f.close(); }
});

test("slow acknowledgments retain one in-flight mutation and resume without another debounce delay", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1000 });
  const f = fixture();
  try {
    f.editor.scene.elements = [{ ...element }];
    f.client.changed();
    t.mock.timers.tick(100);
    const packet = f.socket.sent[0]!;
    assert(packet);
    for (let version = 2; version <= 5; version++) {
      f.editor.scene.elements = [{ ...element, version }];
      f.client.changed();
      t.mock.timers.tick(100);
    }
    assert.equal(f.socket.sent.length, 1);
    const latest = f.editor.scene.elements;
    const committed = { ...update(1, white), elements: packet.mutation.elements };
    f.socket.message({ type: "update", update: committed });
    // Native reconciliation preserves a newer active local element.
    f.editor.scene.elements = latest;
    f.socket.message({ type: "ack", requestId: packet.requestId, update: committed });
    t.mock.timers.tick(0);
    assert.equal(f.socket.sent.length, 2);
    assert.equal(f.socket.sent[1]!.mutation.elements[0]!.version, 5);
  } finally { f.close(); }
});

test("clean reconnect clears an old pending send deadline before accepting new edits", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  try {
    f.editor.scene.elements = [{ ...element }];
    f.client.changed();
    // The disconnect checks the actual scene, even before a revert's callback.
    f.editor.scene.elements = [];
    f.socket.disconnect();
    t.mock.timers.tick(400);
    const replacement = f.sockets[1]!;
    assert(replacement);
    replacement.message({ type: "snapshot", canvas: f.canvas });
    f.editor.applyAll();
    f.editor.scene.elements = [{ ...element }];
    f.client.changed();
    t.mock.timers.tick(100);
    assert.equal(replacement.sent.length, 1);
  } finally { f.close(); }
});

test("onChange does not serialize element geometry during viewport callbacks or continuous edits", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  try {
    const points = Array.from({ length: 1000 }, (_, i) => [i, i]);
    f.socket.message({ type: "update", update: { ...update(1, white), elements: [{ ...element, points }] } });
    f.editor.applyAll();
    let geometryReads = 0;
    Object.defineProperty(f.editor.scene.elements[0]!, "points", {
      enumerable: true, get: () => { geometryReads++; return points; },
    });
    for (let i = 0; i < 100; i++) f.client.changed();
    t.mock.timers.tick(100);
    assert.equal(geometryReads, 0, "viewport/selection callbacks must not fingerprint the scene");
    assert.equal(f.socket.sent.length, 0);
    f.editor.scene.elements[0]!.version++;
    for (let i = 0; i < 100; i++) f.client.changed();
    assert.equal(geometryReads, 0, "native version checks must not inspect geometry");
    t.mock.timers.tick(100);
    assert.equal(f.socket.sent.length, 1);
    assert(geometryReads > 0, "the exact diff and wire payload still contain the full native element");
  } finally { f.close(); }
});

for (const order of ["broadcast-first", "ack-first"] as const) {
  test(`own committed update is normalized and rendered once (${order})`, t => {
    const f = fixture();
    try {
      f.editor.scene.elements = [{ ...element }];
      f.client.changed();
      f.client.flush();
      const normalize = t.mock.method(f.editor, "normalize");
      const render = t.mock.method(f.editor, "render");
      const packet = f.socket.sent[0]!;
      const committed = { ...update(1, white), elements: packet.mutation.elements };
      const broadcast: ServerMessage = { type: "update", update: committed };
      const ack: ServerMessage = { type: "ack", requestId: packet.requestId, update: committed };
      for (const message of order === "broadcast-first" ? [broadcast, ack] : [ack, broadcast]) f.socket.message(message);
      assert.equal(normalize.mock.callCount(), 1);
      assert.equal(render.mock.callCount(), 1);
      f.editor.applyAll();
      assert.equal(f.client.hasUnsavedChanges(), false);
      assert.equal(f.statuses.at(-1)?.message, "Live · Saved");
    } finally { f.close(); }
  });
}

for (const concurrent of [false, true]) {
  test(`no-op acknowledgment still applies authoritative corrections (concurrent=${concurrent})`, t => {
    const f = fixture();
    try {
      const winner = { ...element, version: 2, versionNonce: 1 };
      const losing = { ...element, version: 2, versionNonce: 90 };
      if (!concurrent) {
        f.socket.message({ type: "update", update: { ...update(1, white), elements: [winner] } });
        f.editor.applyAll();
      }
      f.editor.scene.elements = [losing];
      f.client.changed();
      f.client.flush();
      const packet = f.socket.sent[0]!;
      const correction = { ...update(1, white), elements: [winner] };
      if (concurrent) {
        f.socket.message({ type: "update", update: correction });
        f.editor.scene.elements = [losing];
      }
      const render = t.mock.method(f.editor, "render");
      f.socket.message({ type: "ack", requestId: packet.requestId, update: correction });
      assert.equal(render.mock.callCount(), 1, "a rejected mutation must not be mistaken for an already-applied commit");
      assert.deepEqual(f.editor.scene.elements, [winner]);
      f.editor.applyAll();
      assert.equal(f.client.hasUnsavedChanges(), false);
    } finally { f.close(); }
  });
}

for (const phase of ["before-broadcast", "before-ack", "after-ack"] as const) {
  for (const type of ["rectangle", "line"]) {
    test(`native cancellation deletes a throttled ${type} (${phase})`, t => {
      t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
      const f = fixture();
      const server = authoritativeScene();
      try {
        f.editor.scene.elements = [{ ...element, type, width: 80, height: 60, version: 2 }];
        f.editor.activeElements.add(element.id);
        f.client.changed();
        t.mock.timers.tick(100);
        const first = f.socket.sent[0]!;
        assert(first, "the intermediate shape must already have left the browser");
        const committed = server.commit(first.mutation);
        if (phase !== "before-broadcast") {
          f.socket.message({ type: "update", update: committed });
          f.editor.applyAll();
        }
        if (phase === "after-ack") {
          f.socket.message({ type: "ack", requestId: first.requestId, update: committed });
          f.editor.applyAll();
        }
        // Native finalization mutates the active draft, then removes it outright.
        const draft = f.editor.scene.elements[0]!;
        draft.version += 3;
        draft.width = draft.height = 0;
        const canceledVersion = draft.version;
        f.editor.scene.elements = [];
        f.client.changed();
        assert.equal(f.client.hasUnsavedChanges(), true);
        if (phase === "before-broadcast") f.socket.message({ type: "update", update: committed });
        if (phase !== "after-ack") f.socket.message({ type: "ack", requestId: first.requestId, update: committed });
        f.editor.applyAll();
        assert(!f.editor.scene.elements.some(item => !item.isDeleted), "commit echoes must not resurrect the canceled draft");
        assert.equal(f.client.hasUnsavedChanges(), true, "creation confirmation is not cancellation confirmation");
        t.mock.timers.tick(100);
        const deletion = f.socket.sent[1]!;
        assert(deletion);
        const tombstone = deletion.mutation.elements.find(item => item.id === element.id)!;
        assert(tombstone.isDeleted);
        assert(tombstone.version > canceledVersion);
        const deleted = server.commit(deletion.mutation);
        f.socket.message({ type: "update", update: deleted });
        f.socket.message({ type: "ack", requestId: deletion.requestId, update: deleted });
        f.editor.activeElements.clear();
        f.editor.applyAll();
        assert(!server.read().elements.some(item => !item.isDeleted), "authoritative state must stay empty on reopen");
        assert.equal(f.client.hasUnsavedChanges(), false);
        assert.equal(f.statuses.at(-1)?.message, "Live · Saved");
      } finally { f.close(); }
    });
  }
}

test("drafts canceled before their first send and missing remote elements do not produce deletions", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  try {
    f.editor.scene.elements = [{ ...element }];
    f.client.changed();
    f.editor.scene.elements = [];
    f.client.changed();
    t.mock.timers.tick(100);
    assert.equal(f.socket.sent.length, 0);
    f.socket.message({ type: "update", update: { ...update(1, white), elements: [{ ...element, id: "remote" }] } });
    f.editor.applyAll();
    f.editor.scene.elements = [];
    f.client.changed();
    f.client.flush();
    assert.equal(f.socket.sent.length, 0, "only submitted local creations can infer native cancellation");
  } finally { f.close(); }
});

test("cancellation wins over an intervening committed edit and is retained in disconnect recovery", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  const server = authoritativeScene();
  try {
    f.editor.scene.elements = [{ ...element }];
    f.client.changed();
    t.mock.timers.tick(100);
    const first = f.socket.sent[0]!;
    const committed = server.commit(first.mutation);
    f.editor.scene.elements = [];
    // No local callback yet: receive must capture disappearance before rendering.
    f.socket.message({ type: "update", update: committed });
    const edited = server.commit({ elements: [{ ...element, version: 10 }], files: {} });
    f.socket.message({ type: "update", update: edited });
    f.socket.message({ type: "ack", requestId: first.requestId, update: committed });
    t.mock.timers.tick(100);
    const deletion = f.socket.sent[1]!;
    assert(deletion.mutation.elements[0]!.isDeleted);
    assert(deletion.mutation.elements[0]!.version > 10);
    server.commit(deletion.mutation);
    assert(server.read().elements[0]!.isDeleted);
    f.socket.disconnect();
    const recovery = f.client.dispose();
    assert(recovery.unsaved, "unacknowledged deletion must not be treated as a clean disconnect");
    assert(recovery.scene.elements[0]!.isDeleted, "export/recovery must preserve cancellation intent");
  } finally { f.close(); }
});

test("a newer native undo can restore an element after cancellation without a tombstone loop", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  const server = authoritativeScene();
  const acknowledge = (index: number) => {
    const packet = f.socket.sent[index]!;
    const committed = server.commit(packet.mutation);
    f.socket.message({ type: "update", update: committed });
    f.socket.message({ type: "ack", requestId: packet.requestId, update: committed });
    f.editor.applyAll();
  };
  try {
    f.editor.scene.elements = [{ ...element }];
    f.client.changed();
    t.mock.timers.tick(100);
    acknowledge(0);
    f.editor.scene.elements = [];
    f.client.changed();
    t.mock.timers.tick(100);
    const tombstone = f.socket.sent[1]!.mutation.elements[0]!;
    f.editor.scene.elements = [{ ...tombstone, isDeleted: false, version: tombstone.version + 1 }];
    f.client.changed();
    acknowledge(1);
    t.mock.timers.tick(100);
    assert.equal(f.socket.sent.length, 3);
    assert.equal(f.socket.sent[2]!.mutation.elements[0]!.isDeleted, false);
    acknowledge(2);
    assert.equal(server.read().elements[0]!.isDeleted, false);
    assert.equal(f.client.hasUnsavedChanges(), false);
    t.mock.timers.tick(1000);
    assert.equal(f.socket.sent.length, 3);
  } finally { f.close(); }
});

test("a concurrent same-version deletion cannot hide cancellation of an in-flight live draft", t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const f = fixture();
  const server = authoritativeScene();
  try {
    f.editor.activeElements.add(element.id);
    f.editor.scene.elements = [{ ...element, width: 80, height: 60 }];
    f.client.changed();
    t.mock.timers.tick(100);
    const first = f.socket.sent[0]!;
    const created = server.commit(first.mutation);
    f.socket.message({ type: "update", update: created });
    f.socket.message({ type: "ack", requestId: first.requestId, update: created });
    f.editor.scene.elements[0]!.version = 3;
    f.client.changed();
    t.mock.timers.tick(100);
    const moving = f.socket.sent[1]!;
    const remoteDeletion = server.commit({ elements: [{ ...element, isDeleted: true, version: 3, versionNonce: 900 }], files: {} });
    f.socket.message({ type: "update", update: remoteDeletion });
    // Active-editor reconciliation keeps the draft; finalization then drops it
    // without another version increment. The already-sent nonce wins the race.
    f.editor.scene.elements = [];
    f.client.changed();
    const restored = server.commit(moving.mutation);
    assert.equal(server.read().elements[0]!.isDeleted, false);
    f.socket.message({ type: "update", update: restored });
    f.socket.message({ type: "ack", requestId: moving.requestId, update: restored });
    t.mock.timers.tick(100);
    const deletion = f.socket.sent[2]!;
    assert(deletion.mutation.elements[0]!.isDeleted);
    assert(deletion.mutation.elements[0]!.version > 3);
    server.commit(deletion.mutation);
    assert(server.read().elements[0]!.isDeleted);
    assert(!f.editor.scene.elements.some(item => !item.isDeleted));
  } finally { f.close(); }
});

for (const callback of [false, true]) {
  test(`cancellation during a clean reconnect is retained instead of overwritten (callback=${callback})`, t => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const f = fixture();
    try {
      f.editor.scene.elements = [{ ...element }];
      f.client.changed();
      t.mock.timers.tick(100);
      const first = f.socket.sent[0]!;
      const committed = { ...update(1, white), elements: first.mutation.elements };
      f.socket.message({ type: "update", update: committed });
      f.socket.message({ type: "ack", requestId: first.requestId, update: committed });
      f.editor.applyAll();
      f.socket.disconnect();
      f.editor.scene.elements = [];
      if (callback) f.client.changed();
      t.mock.timers.tick(400);
      if (!callback) {
        const replacement = f.sockets[1]!;
        assert(replacement);
        replacement.message({ type: "snapshot", canvas: { ...f.canvas, revision: 1, scene: { ...blank(), elements: [element] } } });
      }
      assert.match(f.statuses.at(-1)?.error ?? "", /unconfirmed cancellation/);
      const recovery = f.client.dispose();
      assert(recovery.unsaved);
      assert(recovery.scene.elements[0]!.isDeleted);
      assert.equal(f.socket.sent.length, 1, "offline cancellation must not be replayed automatically");
    } finally { f.close(); }
  });
}
