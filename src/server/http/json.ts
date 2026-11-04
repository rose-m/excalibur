import type { IncomingMessage, ServerResponse } from "node:http";
import { ServiceError } from "../canvas/errors.js";

const MAX_BODY = 24 * 1024 * 1024;

export function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

export async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"]?.split(";")[0]?.trim() !== "application/json") {
    throw new ServiceError(415, "Expected application/json");
  }
  if (Number(request.headers["content-length"]) > MAX_BODY) {
    throw new ServiceError(413, "Request exceeds 24 MiB");
  }
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY) throw new ServiceError(413, "Request exceeds 24 MiB");
    chunks.push(buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new ServiceError(400, "Invalid JSON"); }
}
