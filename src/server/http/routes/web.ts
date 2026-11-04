import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { ServiceError } from "../../canvas/errors.js";

const mimeTypes: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".woff2": "font/woff2", ".png": "image/png",
  ".svg": "image/svg+xml", ".json": "application/json",
};

export function createWebRoute(webDirectory: string) {
  const root = resolve(webDirectory);

  return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
    if (url.pathname.startsWith("/api/")) throw new ServiceError(404, "Not found");
    if (request.method !== "GET" && request.method !== "HEAD") throw new ServiceError(405, "Method not allowed");

    const isPage = url.pathname === "/" || /^\/canvases\/[a-f0-9-]{36}$/.test(url.pathname);
    const filename = resolve(root, isPage ? "index.html" : `.${decodeURIComponent(url.pathname)}`);
    if (!filename.startsWith(`${root}${sep}`)) throw new ServiceError(404, "Not found");

    try {
      if (!(await stat(filename)).isFile()) throw new ServiceError(404, "Not found");
      const content = await readFile(filename);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(filename)] ?? "application/octet-stream",
        "cache-control": isPage ? "no-cache" : "public, max-age=3600",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ServiceError(404, "Not found. For development, open http://localhost:5173.");
      }
      throw error;
    }
  };
}
