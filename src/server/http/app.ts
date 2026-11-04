import type { IncomingMessage, ServerResponse } from "node:http";
import { developmentContext } from "../auth/context.js";
import type { CanvasService } from "../canvas/service.js";
import { sendError } from "./errors.js";
import { createLocalRequestValidator } from "./local-request.js";
import { createCanvasRoutes } from "./routes/canvases.js";
import { handleHealthRoute } from "./routes/health.js";
import { createWebRoute } from "./routes/web.js";

export function createHandler(service: CanvasService, webDirectory: string, port: number) {
  const validateRequest = createLocalRequestValidator(port);
  const handleCanvasRoute = createCanvasRoutes(service);
  const handleWebRoute = createWebRoute(webDirectory);

  return async (request: IncomingMessage, response: ServerResponse) => {
    response.setHeader("x-content-type-options", "nosniff");
    response.setHeader("referrer-policy", "same-origin");
    try {
      const url = validateRequest(request);
      if (handleHealthRoute(request, response, url)) return;
      if (await handleCanvasRoute(request, response, url, developmentContext)) return;
      await handleWebRoute(request, response, url);
    } catch (error) {
      sendError(response, error);
    }
  };
}
