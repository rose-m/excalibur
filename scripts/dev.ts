import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { localAddresses } from "../src/server/local-network.js";

export function devEnvironment(args: string[], env: NodeJS.ProcessEnv = process.env, addresses = localAddresses()): NodeJS.ProcessEnv {
  const { values } = parseArgs({ args: args.filter(arg => arg !== "--"), options: { "allow-local": { type: "boolean", default: false } }, strict: true });
  const allowLocal = values["allow-local"];
  return {
    ...env,
    AUTH_MODE: env.AUTH_MODE ?? (env.PROPELAUTH_AUTH_URL || env.PROPELAUTH_API_KEY ? "propelauth" : "development"),
    EXCALIBUR_ALLOW_LOCAL: allowLocal ? "1" : "0",
    PUBLIC_URL: env.PUBLIC_URL ?? `http://${allowLocal && addresses[0] ? addresses[0] : "localhost"}:5173`,
  };
}

async function run(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const child = spawn("pnpm", args, { stdio: "inherit", env });
  const interrupt = () => { child.kill("SIGINT"); };
  const terminate = () => { child.kill("SIGTERM"); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 143)));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}

async function main() {
  const env = devEnvironment(process.argv.slice(2));
  if (env.EXCALIBUR_ALLOW_LOCAL === "1") {
    console.warn("LAN access enabled without authentication. Use a trusted network only; anyone who can reach these ports can access your canvases and MCP.");
    for (const address of localAddresses()) console.log(`iPad / LAN: http://${address}:5173`);
  }
  const built = await run(["build:headless"], env);
  process.exitCode = built || await run(["exec", "concurrently", "-k", "-n", "server,web,headless",
    "pnpm dev:server", "pnpm dev:web", "node scripts/build-headless.mjs --watch"], env);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : "Could not start development servers"); process.exitCode = 1; });
}
