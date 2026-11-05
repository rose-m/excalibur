import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { devEnvironment } from "../scripts/dev.js";

test("authentication configuration fails closed and requires explicit development opt-out", () => {
  function load(values: Record<string, string> = {}) {
    const env = { ...process.env };
    for (const key of ["AUTH_MODE", "PROPELAUTH_AUTH_URL", "PROPELAUTH_API_KEY", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET", "EXCALIBUR_ALLOW_LOCAL", "PUBLIC_URL", "PORT"]) delete env[key];
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { config } from './src/server/config.ts'; console.log(config.authMode)"], {
      env: { ...env, ...values }, encoding: "utf8",
    });
  }
  assert.notEqual(load().status, 0);
  assert.match(load().stderr, /PROPELAUTH_AUTH_URL and PROPELAUTH_API_KEY are required/);
  assert.equal(load({ AUTH_MODE: "development" }).status, 0);
  assert.notEqual(load({ AUTH_MODE: "typo" }).status, 0);
  const credentials = { PROPELAUTH_AUTH_URL: "https://auth.example", PROPELAUTH_API_KEY: "secret" };
  assert.equal(load(credentials).status, 0);
  assert.notEqual(load({ ...credentials, AUTH_MODE: "development" }).status, 0);
  assert.notEqual(load({ ...credentials, EXCALIBUR_ALLOW_LOCAL: "1" }).status, 0);
  assert.notEqual(load({ ...credentials, PROPELAUTH_AUTH_URL: "http://auth.example" }).status, 0);
  assert.notEqual(load({ ...credentials, PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID: "id" }).status, 0);
  assert.notEqual(load({ ...credentials, PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET: "secret" }).status, 0);
  const mcpCredentials = { PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID: "id", PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET: "secret" };
  assert.equal(load({ ...credentials, ...mcpCredentials }).status, 0);
  assert.notEqual(load({ ...mcpCredentials, AUTH_MODE: "development" }).status, 0);
  assert.equal(devEnvironment([], {}).AUTH_MODE, "development");
  assert.equal(devEnvironment([], credentials).AUTH_MODE, "propelauth");
});
