import { createMiddleware } from "hono/factory";
import { ServiceError } from "../canvas/errors.js";
import type { HttpEnv } from "./types.js";
import { isLocalAddress, localAddresses } from "../local-network.js";
import { applicationOrigin } from "./origins.js";

const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localRequestPolicy(port: number, allowLocal = false, addresses = localAddresses(), publicUrl?: string, allowedOrigins: readonly string[] = []) {
  const hosts = new Set(localHosts);
  if (allowLocal) for (const address of addresses) if (isLocalAddress(address)) hosts.add(address);
  const origins = new Set([...hosts].flatMap(host => [`http://${host}:${port}`, `http://${host}:5173`]));
  // A mapped container port can differ from the backend's listening port.
  if (publicUrl) {
    const url = new URL(publicUrl);
    if (hosts.has(url.hostname) && ["http:", "https:"].includes(url.protocol)) origins.add(url.origin);
  }
  const allowedHosts = new Set<string>();
  for (const value of allowedOrigins) {
    const origin = applicationOrigin(value, "ALLOWED_ORIGINS");
    origins.add(origin);
    allowedHosts.add(new URL(origin).host);
  }
  return { hosts, origins, allowedHosts };
}

export function localRequestsOnly(port: number, policy = localRequestPolicy(port)) {

  return createMiddleware<HttpEnv>(async (c, next) => {
    // Not authentication: reduce accidental exposure and access from unrelated
    // websites while every local session shares the development identity.
    let host: URL;
    try { host = new URL(`http://${c.req.header("host") ?? "invalid"}`); }
    catch { throw new ServiceError(403, "Invalid request host"); }
    if ((!policy.hosts.has(host.hostname) && !policy.allowedHosts.has(c.req.header("host") ?? "")) || host.username || host.password || host.pathname !== "/" || host.search || host.hash) throw new ServiceError(403, "Host not allowed");
    const origin = c.req.header("origin");
    if (origin && !policy.origins.has(origin)) {
      throw new ServiceError(403, "Origin not allowed");
    }
    if (c.req.header("sec-fetch-site") === "cross-site") {
      throw new ServiceError(403, "Cross-site requests are not allowed");
    }
    await next();
  });
}
