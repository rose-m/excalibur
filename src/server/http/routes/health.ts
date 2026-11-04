import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "../json.js";

export function handleHealthRoute(request: IncomingMessage, response: ServerResponse, url: URL): boolean {
  if (request.method !== "GET" || !["/health/live", "/health/ready"].includes(url.pathname)) return false;
  sendJson(response, 200, { status: "ok" });
  return true;
}
