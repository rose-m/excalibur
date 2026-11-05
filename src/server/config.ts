const port = Number(process.env.PORT ?? 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://127.0.0.1:${port}`);
if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
  throw new Error("PUBLIC_URL must be an http(s) application origin without a path, query or credentials");
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port,
  publicUrl: publicUrl.origin,
  databasePath: process.env.DATABASE_PATH ?? resolve("data/excalibur.sqlite"),
  webDirectory: resolve("dist/web"),
};
import { resolve } from "node:path";
