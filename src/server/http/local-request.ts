import { createMiddleware } from "hono/factory";
import { ServiceError } from "../canvas/errors.js";
import type { HttpEnv } from "./types.js";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localRequestsOnly(port: number) {
  const allowedOrigins = new Set([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`,
    "http://localhost:5173", "http://127.0.0.1:5173",
  ]);

  return createMiddleware<HttpEnv>(async (c, next) => {
    // Not authentication: reduce accidental exposure and access from unrelated
    // websites while every local session shares the development identity.
    const host = new URL(`http://${c.req.header("host") ?? "invalid"}`);
    if (!localHosts.has(host.hostname)) throw new ServiceError(403, "Local development hosts only");
    const origin = c.req.header("origin");
    if (origin && !allowedOrigins.has(origin)) {
      throw new ServiceError(403, "Origin not allowed");
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      throw new ServiceError(403, "Cross-site requests are not allowed");
    }
    await next();
  });
}
