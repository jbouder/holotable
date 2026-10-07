import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PROVIDER_VARIABLE_PREFIXES, unsetEmptyProviderVariables } from "@/lib/env-hygiene";

/** An empty provider variable means unset, for the SDKs as well (#350). */

test("empty provider variables are dropped, declared ones and other families kept", () => {
  const env: NodeJS.ProcessEnv = {
    OPENAI_BASE_URL: "",
    OPENAI_API_KEY: "",
    OPENAI_API: "chat",
    AI_MODEL: "",
    AI_PROVIDER: "openai-compatible",
    AI_GATEWAY_API_KEY: "",
    // An empty value is a real declaration here; `validateConfig` relies on it.
    SOURCE_SECRET_REFS: "",
    DATABASE_URL: "",
  };
  assert.deepEqual(unsetEmptyProviderVariables(env), [
    "AI_GATEWAY_API_KEY",
    "AI_MODEL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ]);
  assert.deepEqual(env, {
    OPENAI_API: "chat",
    AI_PROVIDER: "openai-compatible",
    SOURCE_SECRET_REFS: "",
    DATABASE_URL: "",
  });
  assert.deepEqual(unsetEmptyProviderVariables(env), [], "idempotent");
  assert.deepEqual(PROVIDER_VARIABLE_PREFIXES, ["OPENAI_", "AI_"]);
});

/**
 * The trap itself, in a child process so the import is fresh: the SDK refuses
 * an empty OPENAI_BASE_URL at import, and does not once the value is dropped.
 * If a future SDK stops refusing, the first assertion says the guard can go.
 */
function importProvider(env: Record<string, string>): { ok: boolean; stderr: string } {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "-e", 'import("@/lib/ai/provider").then(() => process.exit(0))'],
    { env: { ...process.env, ...env }, encoding: "utf8", cwd: process.cwd() },
  );
  return { ok: result.status === 0, stderr: result.stderr };
}

test("the provider module refuses to load under an empty OPENAI_BASE_URL, and loads once it is dropped", () => {
  const trapped = importProvider({ OPENAI_BASE_URL: "" });
  assert.equal(trapped.ok, false);
  assert.match(trapped.stderr, /baseURL must be a non-empty string/);

  // What `unsetEmptyProviderVariables` leaves behind.
  const clean = importProvider({});
  assert.equal(clean.ok, true, clean.stderr);
});

test(".env.example has no empty provider assignment, and the hygiene runs where the environment is loaded", () => {
  const example = readFileSync(".env.example", "utf8");
  const empty = example
    .split("\n")
    .filter((line) => /^(OPENAI_|AI_GATEWAY_)[A-Z_]*=\s*$/.test(line));
  assert.deepEqual(empty, [], "comment the line out instead of leaving it empty");

  for (const file of ["src/instrumentation.ts", "scripts/lib/env.ts"]) {
    assert.ok(
      readFileSync(file, "utf8").includes("unsetEmptyProviderVariables"),
      `${file} drops empty provider variables`,
    );
  }
});
