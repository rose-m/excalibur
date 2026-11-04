import type { IncomingMessage, ServerResponse } from "node:http";
import type { OperationContext } from "../../auth/context.js";
import { ServiceError } from "../../canvas/errors.js";
import type { CanvasService } from "../../canvas/service.js";
import { readJson, sendJson } from "../json.js";

export function createCanvasRoutes(service: CanvasService) {
  return async (request: IncomingMessage, response: ServerResponse, url: URL, context: OperationContext): Promise<boolean> => {
    if (url.pathname === "/api/canvases") {
      if (request.method === "GET") {
        sendJson(response, 200, service.list(context));
      } else if (request.method === "POST") {
        sendJson(response, 201, service.create(context, await readJson(request)));
      } else {
        throw new ServiceError(405, "Method not allowed");
      }
      return true;
    }

    const match = /^\/api\/canvases\/([a-f0-9-]{36})$/.exec(url.pathname);
    if (!match) return false;

    const id = match[1]!;
    if (request.method === "GET") {
      sendJson(response, 200, service.get(context, id));
    } else if (request.method === "PUT") {
      sendJson(response, 200, service.save(context, id, await readJson(request)));
    } else {
      throw new ServiceError(405, "Method not allowed");
    }
    return true;
  };
}
