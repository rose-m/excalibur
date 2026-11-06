import { resolve } from "node:path";
import { localAddresses } from "./local-network.js";

const port = Number(process.env.PORT ?? 3000);
const allowLocal = process.argv.includes("--allow-local") || process.env.EXCALIBUR_ALLOW_LOCAL === "1";
const authMode = process.env.AUTH_MODE ?? "propelauth";
if (authMode !== "development" && authMode !== "propelauth") throw new Error("AUTH_MODE must be development or propelauth");
const authUrl = process.env.PROPELAUTH_AUTH_URL;
const apiKey = process.env.PROPELAUTH_API_KEY;
const mcpClientId = process.env.PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID || undefined;
const mcpClientSecret = process.env.PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET || undefined;
const database = {
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
};
for (const key of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"] as const) {
  if (!process.env[key]) throw new Error(`${key} is required`);
}
if (!Number.isInteger(database.port) || database.port < 1 || database.port > 65535) {
  throw new Error("PGPORT must be an integer between 1 and 65535");
}
if (Boolean(mcpClientId) !== Boolean(mcpClientSecret)) throw new Error("Both MCP Request Validation credentials must be set together");
if (authMode === "development" && (mcpClientId || mcpClientSecret)) throw new Error("MCP OAuth credentials require AUTH_MODE=propelauth");
if (authMode === "propelauth") {
  if (!authUrl || !apiKey) throw new Error("PROPELAUTH_AUTH_URL and PROPELAUTH_API_KEY are required");
  const url = new URL(authUrl);
  if (url.protocol !== "https:" || url.origin !== authUrl) throw new Error("PROPELAUTH_AUTH_URL must be an HTTPS origin");
  if (allowLocal) throw new Error("--allow-local is only supported in development authentication mode");
} else if (authUrl || apiKey) throw new Error("Remove PropelAuth credentials before enabling development authentication mode");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const publicUrl = new URL(process.env.PUBLIC_URL ?? `http://${allowLocal ? localAddresses()[0] ?? "127.0.0.1" : "127.0.0.1"}:${port}`);
if (!["http:", "https:"].includes(publicUrl.protocol) || publicUrl.pathname !== "/" || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password) {
  throw new Error("PUBLIC_URL must be an http(s) application origin without a path, query or credentials");
}

export const config = {
  authMode,
  authUrl,
  apiKey,
  mcpClientId,
  mcpClientSecret,
  host: allowLocal ? "0.0.0.0" : process.env.HOST ?? "127.0.0.1",
  allowLocal,
  port,
  publicUrl: publicUrl.origin,
  database,
  webDirectory: resolve("dist/web"),
};
