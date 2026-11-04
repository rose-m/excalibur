import type { ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import { ServiceError } from "../canvas/errors.js";
import type { HttpEnv } from "./types.js";

export const handleError: ErrorHandler<HttpEnv> = (error, c) => {
  c.header("Cache-Control", "no-store");
  if (error instanceof ServiceError) {
    return c.json({ error: error.message }, error.status as ContentfulStatusCode);
  } else if (error instanceof ZodError) {
    return c.json({
      error: "Invalid request",
      details: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    }, 400);
  } else if (error instanceof URIError || error instanceof TypeError) {
    return c.json({ error: "Invalid request" }, 400);
  } else {
    console.error("Request failed", error instanceof Error ? error.message : "Unknown error");
    return c.json({ error: "Internal server error" }, 500);
  }
};
