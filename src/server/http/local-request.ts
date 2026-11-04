import type { IncomingMessage } from "node:http";
import { ServiceError } from "../canvas/errors.js";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function createLocalRequestValidator(port: number) {
  const allowedOrigins = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`,
    "http://localhost:5173", "http://127.0.0.1:5173",
  ]);

  return (request: IncomingMessage): URL => {
    // Not authentication: reduce accidental exposure and access from unrelated
    // websites while every local session shares the development identity.
    const host = new URL(`http://${request.headers.host ?? "invalid"}`);
    if (!localHosts.has(host.hostname)) throw new ServiceError(403, "Local development hosts only");
    if (request.headers.origin && !allowedOrigins.has(request.headers.origin)) {
      throw new ServiceError(403, "Origin not allowed");
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      throw new ServiceError(403, "Cross-site requests are not allowed");
    }
    return new URL(request.url ?? "/", host);
  };
}
