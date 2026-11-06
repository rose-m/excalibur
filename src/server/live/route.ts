import { upgradeWebSocket } from "@hono/node-server";
import type { MiddlewareHandler } from "hono";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { ZodError } from "zod";
import { clientMessageSchema } from "../../shared/live.js";
import type { ServerMessage } from "../../shared/live.js";
import { ServiceError } from "../canvas/errors.js";
import type { CanvasService } from "../canvas/service.js";
import type { HttpEnv } from "../http/types.js";

const maxPendingMessages = 64;
const maxPendingBytes = 32 * 1024 * 1024;

function send(socket: WSContext, message: ServerMessage) {
  const raw = socket.raw as WebSocket | undefined;
  if (raw?.readyState !== 1) return;
  if (raw.bufferedAmount > 32 * 1024 * 1024) {
    socket.close(1013, "Client is too slow; reconnect for a snapshot");
    return;
  }
  socket.send(JSON.stringify(message));
}

export function liveCanvasRoute(service: CanvasService): MiddlewareHandler<HttpEnv> {
  return async (c, next) => {
    // Origin validation and (in authenticated mode) single-use ticket consumption
    // run before this. Require Origin even for non-browser clients; long-lived
    // access tokens never travel in the URL.
    if (!c.req.header("origin")) throw new ServiceError(403, "WebSocket Origin is required");
    const context = c.get("context");
    const id = c.req.param("id")!;
    await service.get(context, id);
    let unsubscribe = () => {};
    let unsubscribeComments = () => {};
    let unsubscribeMetadata = () => {};
    let unsubscribeDeletion = () => {};
    let editor: Awaited<ReturnType<CanvasService["connectEditor"]>> | undefined;
    let closed = false;
    let ready: Promise<unknown> = Promise.resolve();
    let messages: Promise<unknown> = Promise.resolve();
    let pendingMessages = 0;
    let pendingBytes = 0;
    const cleanup = () => { closed = true; unsubscribe(); unsubscribeComments(); unsubscribeMetadata(); unsubscribeDeletion(); editor?.close(); };
    return upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        ready = service.exclusive(id, async () => {
          if (closed) return;
          // Hold the same queue as mutations until subscriptions and the initial
          // snapshot are installed, so no committed update can fall in a gap.
          unsubscribe = await service.subscribe(context, id, (update) => send(socket, { type: "update", update }));
          editor = await service.connectEditor(context, id);
          unsubscribeComments = await service.comments.subscribe(context, id, state => send(socket, { type: "comments", state }));
          unsubscribeMetadata = await service.subscribeMetadata(context, id, metadata => send(socket, { type: "metadata", metadata }));
          unsubscribeDeletion = await service.subscribeDeletion(context, id, () => {
            try { send(socket, { type: "deleted", canvasId: id }); }
            finally { cleanup(); socket.close(1008, "Canvas deleted"); }
          });
          const canvas = await service.get(context, id);
          const comments = await service.comments.get(context, id);
          if (closed) { cleanup(); return; }
          send(socket, { type: "snapshot", canvas, comments });
        }).catch(() => { cleanup(); socket.close(1008, "Canvas unavailable"); });
      },
      onMessage(event, socket) {
        if (closed) return;
        // Reject binary input immediately rather than retaining it in the queue.
        if (typeof event.data !== "string") {
          send(socket, { type: "error", status: 400, message: "Text JSON messages only" });
          return;
        }
        const data = event.data;
        const bytes = Buffer.byteLength(data);
        // Include the in-flight message, including during room initialization.
        if (pendingMessages >= maxPendingMessages || pendingBytes + bytes > maxPendingBytes) {
          cleanup();
          socket.close(1013, "Too many pending messages; reconnect for a snapshot");
          return;
        }
        pendingMessages++;
        pendingBytes += bytes;
        messages = messages.then(async () => {
          try {
            await ready;
            if (closed) return;
            let requestId: string | undefined;
            try {
              let body: unknown;
              try { body = JSON.parse(data) as unknown; }
              catch { throw new ServiceError(400, "Invalid JSON"); }
              const message = clientMessageSchema.parse(body);
              if (message.type === "selection") { await editor?.setSelection(message.elementIds); return; }
              requestId = message.requestId;
              const update = await service.mutate(context, id, message.mutation);
              send(socket, { type: "ack", requestId, update });
            } catch (error) {
              const status = error instanceof ServiceError ? error.status : error instanceof ZodError ? 400 : 500;
              send(socket, { type: "error", ...(requestId ? { requestId } : {}), status,
                message: error instanceof ServiceError ? error.message : status === 400 ? "Invalid live message" : "Live operation failed" });
            }
          } finally {
            pendingMessages--;
            pendingBytes -= bytes;
          }
        }).catch(() => {
          cleanup();
          socket.close(1011, "Live operation failed");
        });
      },
      onClose() { cleanup(); },
      onError() { cleanup(); },
    }), { onError: cleanup })(c, next);
  };
}
