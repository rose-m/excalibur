import type { HonoRequest } from "hono";
import { ServiceError } from "../canvas/errors.js";

// The application body-limit middleware bounds both fixed and streamed bodies.
export async function readJson(request: HonoRequest): Promise<unknown> {
  if (request.header("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new ServiceError(415, "Expected application/json");
  }
  try { return await request.json<unknown>(); }
  catch { throw new ServiceError(400, "Invalid JSON"); }
}
