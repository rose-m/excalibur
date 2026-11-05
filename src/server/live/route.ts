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
    service.get(context, id);
    let unsubscribe = () => {};
    let unsubscribeComments = () => {};
    let unsubscribeMetadata = () => {};
    let editor: ReturnType<CanvasService["connectEditor"]> | undefined;
    const cleanup = () => { unsubscribe(); unsubscribeComments(); unsubscribeMetadata(); editor?.close(); };
    return upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        try {
          // Subscribe and read synchronously: no mutation can land in a gap
          // between room registration and the authoritative initial snapshot.
          unsubscribe = service.subscribe(context, id, (update) => send(socket, { type: "update", update }));
          editor = service.connectEditor(context, id);
          unsubscribeComments = service.comments.subscribe(context, id, state => send(socket, { type: "comments", state }));
          unsubscribeMetadata = service.subscribeMetadata(context, id, metadata => send(socket, { type: "metadata", metadata }));
          send(socket, { type: "snapshot", canvas: service.get(context, id), comments: service.comments.get(context, id) });
        } catch { cleanup(); socket.close(1008, "Canvas unavailable"); }
      },
      onMessage(event, socket) {
        let requestId: string | undefined;
        try {
          if (typeof event.data !== "string") throw new ServiceError(400, "Text JSON messages only");
          let body: unknown;
          try { body = JSON.parse(event.data) as unknown; }
          catch { throw new ServiceError(400, "Invalid JSON"); }
          const message = clientMessageSchema.parse(body);
          if (message.type === "selection") { editor?.setSelection(message.elementIds); return; }
          requestId = message.requestId;
          const update = service.mutate(context, id, message.mutation);
          send(socket, { type: "ack", requestId, update });
        } catch (error) {
          const status = error instanceof ServiceError ? error.status : error instanceof ZodError ? 400 : 500;
          send(socket, { type: "error", ...(requestId ? { requestId } : {}), status,
            message: error instanceof ServiceError ? error.message : status === 400 ? "Invalid live message" : "Live operation failed" });
        }
      },
      onClose() { cleanup(); },
      onError() { cleanup(); },
    }), { onError: cleanup })(c, next);
  };
}
