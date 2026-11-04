import type { ServerResponse } from "node:http";
import { ZodError } from "zod";
import { ServiceError } from "../canvas/errors.js";
import { sendJson } from "./json.js";

export function sendError(response: ServerResponse, error: unknown) {
  if (error instanceof ServiceError) {
    sendJson(response, error.status, { error: error.message });
  } else if (error instanceof ZodError) {
    sendJson(response, 400, {
      error: "Invalid request",
      details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    });
  } else if (error instanceof URIError || error instanceof TypeError) {
    sendJson(response, 400, { error: "Invalid request" });
  } else {
    console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
    sendJson(response, 500, { error: "Internal server error" });
  }
}
