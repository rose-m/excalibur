import { WebSocketServer } from "ws";
import type { serve } from "@hono/node-server";

type HonoWebSocketOptions = NonNullable<Parameters<typeof serve>[0]["websocket"]>;

export function createLiveServer() {
  const server = new WebSocketServer({
    noServer: true, maxPayload: 24 * 1024 * 1024, perMessageDeflate: false,
  });
  const alive = new WeakSet<object>();
  server.on("connection", (socket) => {
    alive.add(socket);
    socket.on("pong", () => { alive.add(socket); });
    socket.on("error", () => { socket.terminate(); });
  });
  const heartbeat = setInterval(() => {
    for (const socket of server.clients) {
      if (!alive.has(socket)) { socket.terminate(); continue; }
      alive.delete(socket);
      socket.ping();
    }
  }, 30_000);
  heartbeat.unref();
  server.once("close", () => clearInterval(heartbeat));
  return {
    sockets: server,
    // Hono officially supports ws. Its structural adapter types do not match
    // @types/ws's overloaded send/optional options under strict TS settings.
    adapter: { server: server as unknown as HonoWebSocketOptions["server"] },
  };
}
