import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatConfigProblems,
  validateConfig,
  validateSourceSecrets,
  type ConfigProblem,
  type Environment,
} from "@/lib/config";
import { runStartupChecks } from "@/lib/startup";

/** Parse a dotenv file the simple way: `KEY=value` lines, `#` comments. */
function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const EXAMPLE_ENV = parseDotenv(
  readFileSync(new URL("../.env.example", import.meta.url), "utf8"),
);

/** A configuration that passes production validation outright. */
const VALID_PRODUCTION: Environment = {
  DATABASE_URL: "postgresql://holotable:pw@db.internal:5432/holotable",
  SESSION_SECRET: "k3Jd9sLq2mZx8vBn4tRw7yUa1cFe6hGp0oIiPlKj",
  AI_PROVIDER: "openai-compatible",
  AI_MODEL: "openai/gpt-4o-mini",
  OPENAI_BASE_URL: "https://openrouter.ai/api/v1",
  OPENAI_API_KEY: "sk-test",
  OIDC_ISSUER: "https://kc.example.com/realms/holotable",
  OIDC_CLIENT_ID: "holotable",
  OIDC_CLIENT_SECRET: "s3cret",
  OIDC_JWKS_URL: "https://kc.example.com/realms/holotable/protocol/openid-connect/certs",
  OIDC_REDIRECT_URI: "https://holotable.example.com/api/auth/callback",
};

const errors = (problems: ConfigProblem[]) =>
  problems.filter((p) => p.severity === "error");
const warnings = (problems: ConfigProblem[]) =>
  problems.filter((p) => p.severity === "warning");
const variables = (problems: ConfigProblem[]) => problems.map((p) => p.variable);

test("a complete production configuration has no problems", () => {
  assert.deepEqual(validateConfig(VALID_PRODUCTION, { production: true }), []);
});

test("CSP_REPORT_ONLY must be a boolean literal", () => {
  const bad = validateConfig(
    { ...VALID_PRODUCTION, CSP_REPORT_ONLY: "yes" },
    { production: true },
  );
  assert.deepEqual(variables(errors(bad)), ["CSP_REPORT_ONLY"]);
  assert.match(bad[0].message, /"true" or "false"/);
  for (const value of ["true", "false", ""]) {
    const ok = validateConfig(
      { ...VALID_PRODUCTION, CSP_REPORT_ONLY: value },
      { production: true },
    );
    assert.deepEqual(errors(ok), []);
  }
});

test("a report-only CSP in production boots with a warning that names the risk", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, CSP_REPORT_ONLY: "true" },
    { production: true },
  );
  assert.deepEqual(errors(problems), []);
  assert.deepEqual(variables(warnings(problems)), ["CSP_REPORT_ONLY"]);
  assert.match(problems[0].message, /reported, not enforced/);
  // In development report-only is a deliberate rollout step, not a problem.
  const dev = validateConfig(
    { ...VALID_PRODUCTION, CSP_REPORT_ONLY: "true" },
    { production: false },
  );
  assert.ok(!variables(dev).includes("CSP_REPORT_ONLY"));
});

test("development defaults: .env.example boots with warnings only", () => {
  const problems = validateConfig(EXAMPLE_ENV, { production: false });
  assert.deepEqual(errors(problems), [], formatConfigProblems(problems));
  // The example leaves the deployment-specific values blank on purpose, and
  // each of those is called out so the developer knows what will not work yet.
  for (const v of ["DATABASE_URL", "AI_MODEL", "OPENAI_API_KEY"]) {
    assert.ok(variables(warnings(problems)).includes(v), `expected a warning for ${v}`);
  }
});

test("an empty environment in development boots with warnings only", () => {
  const problems = validateConfig({}, { production: false });
  assert.deepEqual(errors(problems), []);
  assert.ok(problems.length > 0);
});

test("production: a missing SESSION_SECRET is fatal with a precise message", () => {
  const { SESSION_SECRET: _omit, ...env } = VALID_PRODUCTION;
  const problems = validateConfig(env, { production: true });
  assert.deepEqual(variables(errors(problems)), ["SESSION_SECRET"]);
  assert.match(problems[0].message, /is not set/);
  assert.match(problems[0].message, /at least 32 characters/);
});

test("production: a short SESSION_SECRET is fatal and says how short", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, SESSION_SECRET: "tooshort" },
    { production: true },
  );
  assert.deepEqual(variables(errors(problems)), ["SESSION_SECRET"]);
  assert.match(problems[0].message, /is 8 characters; it must be at least 32/);
});

test("production: the .env.example placeholder SESSION_SECRET is fatal, not a warning", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, SESSION_SECRET: EXAMPLE_ENV.SESSION_SECRET },
    { production: true },
  );
  assert.deepEqual(variables(errors(problems)), ["SESSION_SECRET"]);
  assert.match(problems[0].message, /placeholder from \.env\.example/);
});

test("production: a low-entropy SESSION_SECRET is fatal", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, SESSION_SECRET: "a".repeat(40) },
    { production: true },
  );
  assert.deepEqual(variables(errors(problems)), ["SESSION_SECRET"]);
  assert.match(problems[0].message, /distinct characters/);
});

test("development: a weak SESSION_SECRET is a warning because the fallback key is used", () => {
  const problems = validateConfig({ SESSION_SECRET: "short" }, { production: false });
  const secret = problems.filter((p) => p.variable === "SESSION_SECRET");
  assert.equal(secret.length, 1);
  assert.equal(secret[0].severity, "warning");
});

test("production: an unset AI_MODEL refuses to boot", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, AI_MODEL: "" },
    { production: true },
  );
  assert.deepEqual(variables(errors(problems)), ["AI_MODEL"]);
  assert.match(problems[0].message, /generate request/);
});

test("the provider's key is required for the selected provider only", () => {
  const openai = validateConfig(
    { ...VALID_PRODUCTION, OPENAI_API_KEY: undefined },
    { production: true },
  );
  assert.deepEqual(variables(errors(openai)), ["OPENAI_API_KEY"]);

  const gateway = validateConfig(
    { ...VALID_PRODUCTION, AI_PROVIDER: "gateway", OPENAI_API_KEY: undefined },
    { production: true },
  );
  assert.deepEqual(variables(errors(gateway)), ["AI_GATEWAY_API_KEY"]);
});

test("an unknown AI_PROVIDER is an error in every environment", () => {
  for (const production of [true, false]) {
    const problems = validateConfig(
      { ...VALID_PRODUCTION, AI_PROVIDER: "anthropic" },
      { production },
    );
    const e = errors(problems);
    assert.deepEqual(variables(e), ["AI_PROVIDER"]);
    assert.match(e[0].message, /"gateway" or "openai-compatible"/);
  }
});

test("production: the OIDC client must be configured completely", () => {
  const { OIDC_CLIENT_SECRET: _s, OIDC_JWKS_URL: _j, ...env } = VALID_PRODUCTION;
  const problems = validateConfig(env, { production: true });
  assert.deepEqual(variables(errors(problems)).sort(), [
    "OIDC_CLIENT_SECRET",
    "OIDC_JWKS_URL",
  ]);
});

test("development: only the OIDC issuer and client id are called out, as warnings", () => {
  const problems = validateConfig({}, { production: false });
  const oidc = problems.filter((p) => p.variable.startsWith("OIDC_"));
  assert.deepEqual(variables(oidc).sort(), ["OIDC_CLIENT_ID", "OIDC_ISSUER"]);
  assert.ok(oidc.every((p) => p.severity === "warning"));
});

test("a JWKS URL on a different origin from the issuer is a warning", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, OIDC_JWKS_URL: "https://other.example.com/certs" },
    { production: true },
  );
  assert.deepEqual(variables(problems), ["OIDC_JWKS_URL"]);
  assert.equal(problems[0].severity, "warning");
});

test("malformed values are errors regardless of environment", () => {
  const env: Environment = {
    DATABASE_URL: "mysql://nope",
    OIDC_ISSUER: "kc.example.com/realms/holotable",
    OPENAI_BASE_URL: "not a url",
    OPENAI_API: "completions",
    OIDC_SCOPE: "profile email",
    MAX_QUERY_ROWS: "lots",
    MAX_RESULT_BYTES: "0",
    QUERY_TIMEOUT_SECONDS: "-5",
    DEFAULT_TIME_FROM: "yesterday-ish",
    SESSION_COOKIE_NAME: "has space",
  };
  const problems = validateConfig(env, { production: false });
  const e = variables(errors(problems)).sort();
  for (const v of Object.keys(env)) {
    assert.ok(e.includes(v), `expected an error for ${v}, got ${e.join(", ")}`);
  }
  // A malformed value is reported once, for its shape, not again as missing.
  assert.equal(e.filter((v) => v === "DATABASE_URL").length, 1);
});

test("a minimum refresh interval above the default is an error", () => {
  const problems = validateConfig(
    { MIN_REFRESH_INTERVAL_MS: "30000", DEFAULT_REFRESH_INTERVAL_MS: "15000" },
    { production: false },
  );
  assert.deepEqual(variables(errors(problems)), ["MIN_REFRESH_INTERVAL_MS"]);
});

test("a default time range that is not before its end is an error", () => {
  const problems = validateConfig(
    { DEFAULT_TIME_FROM: "now", DEFAULT_TIME_TO: "now-1h" },
    { production: false },
  );
  assert.deepEqual(variables(errors(problems)), ["DEFAULT_TIME_FROM"]);
});

test("every problem is reported in one pass", () => {
  const problems = validateConfig(
    { DATABASE_URL: "mysql://nope", AI_PROVIDER: "wat", MIN_REFRESH_INTERVAL_MS: "abc" },
    { production: true },
  );
  const found = variables(errors(problems));
  for (const v of [
    "DATABASE_URL",
    "AI_PROVIDER",
    "MIN_REFRESH_INTERVAL_MS",
    "SESSION_SECRET",
    "AI_MODEL",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_JWKS_URL",
  ]) {
    assert.ok(found.includes(v), `expected ${v} among ${found.join(", ")}`);
  }
});

test("source secret_refs missing credentials are warnings naming the variable", () => {
  const problems = validateSourceSecrets(["TS_METRICS", "PROD_DB", "TS_METRICS"], {
    TS_METRICS_USERNAME: "metrics_ro",
    TS_METRICS_PASSWORD: "",
    PROD_DB_PASSWORD: "pw",
  });
  // An empty password is allowed (resolveCredentials accepts it); an empty or
  // missing username is not. Duplicate refs are checked once.
  assert.deepEqual(variables(problems), ["PROD_DB_USERNAME"]);
  assert.ok(problems.every((p) => p.severity === "warning"));
  assert.match(problems[0].message, /secret_ref "PROD_DB"/);
});

test("the report lists every problem, errors first, with a verdict", () => {
  const report = formatConfigProblems([
    { variable: "TS_METRICS_USERNAME", message: "is not set.", severity: "warning" },
    { variable: "SESSION_SECRET", message: "is not set.", severity: "error" },
    { variable: "AI_MODEL", message: "is not set.", severity: "error" },
  ]);
  const lines = report.split("\n");
  assert.match(lines[0], /invalid \(2 errors, 1 warning\); refusing to start/);
  assert.match(lines[1], /^ {2}error {4}SESSION_SECRET: is not set\.$/);
  assert.match(lines[2], /^ {2}error {4}AI_MODEL: is not set\.$/);
  assert.match(lines[3], /^ {2}warning {2}TS_METRICS_USERNAME: is not set\.$/);
});

test("startup checks: an invalid production environment is not ok", async () => {
  const result = await runStartupChecks({
    env: { NODE_ENV: "production" },
    loadSecretRefs: null,
  });
  assert.equal(result.ok, false);
  assert.ok(result.report?.includes("refusing to start"));
});

test("startup checks: the example environment is ok in development", async () => {
  const result = await runStartupChecks({
    env: EXAMPLE_ENV,
    production: false,
    loadSecretRefs: null,
  });
  assert.equal(result.ok, true);
});

test("startup checks: source credentials are checked when the database answers", async () => {
  const result = await runStartupChecks({
    env: { ...VALID_PRODUCTION, TS_METRICS_USERNAME: "ro" },
    production: true,
    loadSecretRefs: async () => ["TS_METRICS"],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(variables(result.problems), ["TS_METRICS_PASSWORD"]);
});

test("startup checks: an unreachable database degrades the source check to a warning", async () => {
  const result = await runStartupChecks({
    env: VALID_PRODUCTION,
    production: true,
    loadSecretRefs: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.problems.length, 1);
  assert.equal(result.problems[0].severity, "warning");
  assert.match(result.problems[0].message, /ECONNREFUSED/);
});

test("startup checks: a malformed DATABASE_URL skips the source query", async () => {
  let called = false;
  const result = await runStartupChecks({
    env: { ...VALID_PRODUCTION, DATABASE_URL: "mysql://nope" },
    production: true,
    loadSecretRefs: async () => {
      called = true;
      return [];
    },
  });
  assert.equal(called, false);
  assert.equal(result.ok, false);
});

test("LLM limits must be non-negative integers", () => {
  const bad = validateConfig(
    { ...VALID_PRODUCTION, LLM_RATE_PER_MINUTE: "-1", LLM_DAILY_TOKEN_BUDGET: "lots" },
    { production: true },
  );
  assert.deepEqual(variables(errors(bad)).sort(), [
    "LLM_DAILY_TOKEN_BUDGET",
    "LLM_RATE_PER_MINUTE",
  ]);
  for (const p of errors(bad)) assert.match(p.message, /0 disables the limit/);
  assert.deepEqual(
    validateConfig(
      {
        ...VALID_PRODUCTION,
        LLM_RATE_PER_MINUTE: "30",
        LLM_DAILY_TOKEN_BUDGET: "500000",
      },
      { production: true },
    ),
    [],
  );
});

test("a disabled LLM limit is a warning in production only", () => {
  const off = {
    ...VALID_PRODUCTION,
    LLM_RATE_PER_MINUTE: "0",
    LLM_DAILY_TOKEN_BUDGET: "0",
  };
  const prod = validateConfig(off, { production: true });
  assert.deepEqual(errors(prod), []);
  assert.deepEqual(variables(warnings(prod)).sort(), [
    "LLM_DAILY_TOKEN_BUDGET",
    "LLM_RATE_PER_MINUTE",
  ]);
  for (const p of warnings(prod)) assert.match(p.message, /is 0;/);
  assert.deepEqual(validateConfig(off, { production: false }), []);
});

test("build identity is optional and never blocks a boot", () => {
  // APP_VERSION and GIT_COMMIT label the build in GET /api/health. Neither is
  // required — the version falls back to package.json and the commit to
  // "unknown" — so neither may ever produce a problem, in any environment.
  for (const production of [true, false]) {
    assert.deepEqual(validateConfig(VALID_PRODUCTION, { production }), []);
    assert.deepEqual(
      validateConfig(
        { ...VALID_PRODUCTION, APP_VERSION: "1.4.0", GIT_COMMIT: "0f2c1ab" },
        { production },
      ),
      [],
    );
  }
});
