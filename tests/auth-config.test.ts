import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { devEnvironment } from "../scripts/dev.js";

test("Postgres configuration passes separate connection fields without URL encoding", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { config } from './src/server/config.ts'; console.log(JSON.stringify(config.database))"], {
    env: {
      AUTH_MODE: "development", PGHOST: "db.internal", PGPORT: "6543",
      PGDATABASE: "deployment", PGUSER: "app-user", PGPASSWORD: "p@ss:/?#word",
    }, encoding: "utf8",
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    host: "db.internal", port: 6543, database: "deployment", user: "app-user", password: "p@ss:/?#word",
  });
});

test("authentication configuration fails closed and requires explicit development opt-out", () => {
  function load(values: Record<string, string> = {}) {
    const env = { ...process.env };
    for (const key of ["AUTH_MODE", "PROPELAUTH_AUTH_URL", "PROPELAUTH_API_KEY", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_ID", "PROPELAUTH_REQUEST_VALIDATION_CLIENT_SECRET", "EXCALIBUR_ALLOW_LOCAL", "PUBLIC_URL", "PORT"]) delete env[key];
    return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", "import { config } from './src/server/config.ts'; console.log(config.authMode)"], {
      env: { ...env, PGHOST: "127.0.0.1", PGPORT: "5432", PGDATABASE: "excalibur", PGUSER: "excalibur", PGPASSWORD: "excalibur", ...values }, encoding: "utf8",
    });
  }
  assert.notEqual(load().status, 0);
  assert.match(load().stderr, /PROPELAUTH_AUTH_URL and PROPELAUTH_API_KEY are required/);
  assert.equal(load({ AUTH_MODE: "development" }).status, 0);
  for (const key of ["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
    assert.match(load({ AUTH_MODE: "development", [key]: "" }).stderr, new RegExp(`${key} is required`));
  }
  for (const value of ["", "abc", "0", "65536", "5432.5"]) {
    assert.match(load({ AUTH_MODE: "development", PGPORT: value }).stderr, /PGPORT must be an integer/);
  }
  assert.equal(load({ AUTH_MODE: "development", PGPASSWORD: "p@ss:/?#word" }).status, 0);
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
