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
    // Local origin validation middleware runs before this. Require Origin even
    // for non-browser clients; cookies/tokens never travel in the URL.
    if (!c.req.header("origin")) throw new ServiceError(403, "WebSocket Origin is required");
    const context = c.get("context");
    const id = c.req.param("id")!;
    service.get(context, id);
    let unsubscribe = () => {};
    return upgradeWebSocket(() => ({
      onOpen(_event, socket) {
        try {
          // Subscribe and read synchronously: no mutation can land in a gap
          // between room registration and the authoritative initial snapshot.
          unsubscribe = service.subscribe(context, id, (update) => send(socket, { type: "update", update }));
          send(socket, { type: "snapshot", canvas: service.get(context, id) });
        } catch { unsubscribe(); socket.close(1008, "Canvas unavailable"); }
      },
      onMessage(event, socket) {
        let requestId: string | undefined;
        try {
          if (typeof event.data !== "string") throw new ServiceError(400, "Text JSON messages only");
          let body: unknown;
          try { body = JSON.parse(event.data) as unknown; }
          catch { throw new ServiceError(400, "Invalid JSON"); }
          const message = clientMessageSchema.parse(body);
          requestId = message.requestId;
          const update = service.mutate(context, id, message.mutation);
          send(socket, { type: "ack", requestId, update });
        } catch (error) {
          const status = error instanceof ServiceError ? error.status : error instanceof ZodError ? 400 : 500;
          send(socket, { type: "error", ...(requestId ? { requestId } : {}), status,
            message: error instanceof ServiceError ? error.message : status === 400 ? "Invalid mutation" : "Mutation failed" });
        }
      },
      onClose() { unsubscribe(); },
      onError() { unsubscribe(); },
    }), { onError: () => { unsubscribe(); } })(c, next);
  };
}
