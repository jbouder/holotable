import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  formatConfigProblems,
  validateConfig,
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
  SOURCE_SECRET_REFS: "TS_METRICS:demo",
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

test("SHUTDOWN_GRACE_MS is a positive number of milliseconds or unset", () => {
  // Unset is the common case: the drain budget has a 10s default, and a
  // deployment only sets it to match its own kill timeout.
  assert.deepEqual(validateConfig(VALID_PRODUCTION, { production: true }), []);
  for (const value of ["1000", "30000", ""]) {
    const ok = validateConfig(
      { ...VALID_PRODUCTION, SHUTDOWN_GRACE_MS: value },
      { production: true },
    );
    assert.deepEqual(errors(ok), [], formatConfigProblems(ok));
  }
  // 0 would make the drain a no-op, which is the behaviour this exists to fix.
  for (const value of ["0", "-1", "soon"]) {
    const bad = validateConfig(
      { ...VALID_PRODUCTION, SHUTDOWN_GRACE_MS: value },
      { production: true },
    );
    assert.deepEqual(variables(errors(bad)), ["SHUTDOWN_GRACE_MS"]);
    assert.match(bad[0].message, /positive integer/);
  }
});

test("chat history limits are bounded, and zero days means keep forever", () => {
  for (const value of ["1", "500", ""]) {
    const ok = validateConfig(
      { ...VALID_PRODUCTION, CHAT_HISTORY_MAX_MESSAGES: value },
      { production: true },
    );
    assert.deepEqual(errors(ok), [], formatConfigProblems(ok));
  }
  // A cap of zero would store a conversation and then never show it.
  for (const value of ["0", "-1", "many"]) {
    const bad = validateConfig(
      { ...VALID_PRODUCTION, CHAT_HISTORY_MAX_MESSAGES: value },
      { production: true },
    );
    assert.deepEqual(variables(errors(bad)), ["CHAT_HISTORY_MAX_MESSAGES"]);
  }
  // Zero DAYS is meaningful — like CATALOG_STALE_AFTER_DAYS, it turns the age
  // check off and leaves the message cap as the only bound.
  assert.deepEqual(
    validateConfig({ CHAT_HISTORY_RETENTION_DAYS: "0" }, { production: false }).filter(
      (p) => p.variable === "CHAT_HISTORY_RETENTION_DAYS",
    ),
    [],
  );
  assert.deepEqual(
    variables(
      errors(
        validateConfig({ CHAT_HISTORY_RETENTION_DAYS: "-7" }, { production: false }),
      ),
    ),
    ["CHAT_HISTORY_RETENTION_DAYS"],
  );
});

test("generation log retention is non-negative, and zero means keep forever", () => {
  for (const value of ["0", "30", "365", ""]) {
    const ok = validateConfig(
      { ...VALID_PRODUCTION, GENERATION_LOG_RETENTION_DAYS: value },
      { production: true },
    );
    assert.deepEqual(errors(ok), [], formatConfigProblems(ok));
  }
  for (const value of ["-1", "forever"]) {
    const bad = validateConfig(
      { ...VALID_PRODUCTION, GENERATION_LOG_RETENTION_DAYS: value },
      { production: true },
    );
    assert.deepEqual(variables(errors(bad)), ["GENERATION_LOG_RETENTION_DAYS"]);
  }
});

test("malformed values are errors regardless of environment", () => {
  const env: Environment = {
    DATABASE_URL: "mysql://nope",
    OIDC_ISSUER: "kc.example.com/realms/holotable",
    OPENAI_BASE_URL: "not a url",
    OPENAI_API: "completions",
    OIDC_SCOPE: "profile email",
    OIDC_ACCOUNT_URL: "kc.example.com/realms/holotable/account",
    MAX_QUERY_ROWS: "lots",
    MAX_RESULT_BYTES: "0",
    QUERY_TIMEOUT_SECONDS: "-5",
    CATALOG_STALE_AFTER_DAYS: "-1",
    SHUTDOWN_GRACE_MS: "forever",
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

test("a catalog staleness threshold of zero is allowed and disables the check", () => {
  // Unlike the other numeric limits, 0 is meaningful here: it turns off the
  // age warning while leaving the never-refreshed refusal in place.
  assert.deepEqual(
    validateConfig({ CATALOG_STALE_AFTER_DAYS: "0" }, { production: false }).filter(
      (p) => p.variable === "CATALOG_STALE_AFTER_DAYS",
    ),
    [],
  );
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

test("SOURCE_SECRET_REFS unset fails closed: an error in production, a warning in development", () => {
  const { SOURCE_SECRET_REFS: _unset, ...env } = VALID_PRODUCTION;

  const prod = validateConfig(env, { production: true });
  assert.deepEqual(variables(errors(prod)), ["SOURCE_SECRET_REFS"]);
  assert.match(errors(prod)[0].message, /no source can resolve credentials/);

  const dev = validateConfig(env, { production: false });
  assert.deepEqual(variables(errors(dev)), []);
  assert.ok(
    dev.some((p) => p.variable === "SOURCE_SECRET_REFS" && p.severity === "warning"),
  );
});

test("SOURCE_SECRET_REFS set empty is a valid declaration of no sources", () => {
  assert.deepEqual(
    validateConfig({ ...VALID_PRODUCTION, SOURCE_SECRET_REFS: "" }, { production: true }),
    [],
  );
});

test("a malformed SOURCE_SECRET_REFS is an error in every environment", () => {
  for (const production of [true, false]) {
    const problems = validateConfig(
      { ...VALID_PRODUCTION, SOURCE_SECRET_REFS: "TS_METRICS:demo;TS_METRICS:ops" },
      { production },
    );
    assert.deepEqual(variables(errors(problems)), ["SOURCE_SECRET_REFS"]);
    assert.match(errors(problems)[0].message, /more than once/);
  }
});

test("SOURCE_SECRETS_DIR must be an absolute path", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, SOURCE_SECRETS_DIR: "secrets" },
    { production: true },
  );
  assert.deepEqual(variables(errors(problems)), ["SOURCE_SECRETS_DIR"]);
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
    loadSecretRefs: async () => [
      { secretRef: "TS_METRICS", workspaceId: "demo" },
      { secretRef: "TS_METRICS", workspaceId: "ops" },
    ],
  });
  assert.equal(result.ok, true);
  const byVariable = new Map(result.problems.map((p) => [p.variable, p.message]));
  assert.deepEqual([...byVariable.keys()].sort(), [
    "SOURCE_SECRET_REFS",
    "TS_METRICS_USERNAME",
  ]);
  assert.match(byVariable.get("SOURCE_SECRET_REFS") ?? "", /workspace "ops"/);
  assert.match(byVariable.get("TS_METRICS_USERNAME") ?? "", /TS_METRICS_PASSWORD/);
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

test("METRICS_ALLOWED_CIDRS must parse, or the server does not boot", () => {
  // An entry that does not parse is dropped by the gate, which would quietly
  // narrow the allowlist an operator thought they had written.
  const bad = validateConfig(
    { ...VALID_PRODUCTION, METRICS_ALLOWED_CIDRS: "10.0.0.0/8, not-an-address" },
    { production: true },
  );
  assert.deepEqual(variables(errors(bad)), ["METRICS_ALLOWED_CIDRS"]);
  assert.match(errors(bad)[0].message, /CIDR/);

  assert.deepEqual(
    validateConfig(
      {
        ...VALID_PRODUCTION,
        METRICS_TOKEN: "0123456789abcdef0123456789abcdef",
        METRICS_ALLOWED_CIDRS: "10.0.0.0/8, ::1, 127.0.0.1",
      },
      { production: true },
    ),
    [],
  );
});

test("an unconfigured metrics endpoint is not a problem; it is the default", () => {
  // /api/metrics answers 404 until one of the two is set, so silence here is
  // correct — the endpoint is closed, not misconfigured.
  assert.deepEqual(validateConfig(VALID_PRODUCTION, { production: true }), []);
});

test("a CIDR allowlist without a token warns that it trusts a header", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, METRICS_ALLOWED_CIDRS: "10.0.0.0/8" },
    { production: true },
  );
  assert.deepEqual(errors(problems), []);
  assert.deepEqual(variables(warnings(problems)), ["METRICS_ALLOWED_CIDRS"]);
  assert.match(warnings(problems)[0].message, /X-Forwarded-For/);
  // Development is where an operator scrapes over a loopback allowlist.
  assert.deepEqual(
    validateConfig({ METRICS_ALLOWED_CIDRS: "127.0.0.1" }, { production: false }).filter(
      (p) => p.variable.startsWith("METRICS_"),
    ),
    [],
  );
});

test("a short scrape token warns rather than blocking a boot", () => {
  const problems = validateConfig(
    { ...VALID_PRODUCTION, METRICS_TOKEN: "short" },
    { production: true },
  );
  assert.deepEqual(errors(problems), []);
  assert.deepEqual(variables(warnings(problems)), ["METRICS_TOKEN"]);
  assert.match(warnings(problems)[0].message, /openssl rand/);
});

test("LOG_LEVEL and LOG_FORMAT accept only their own vocabularies", () => {
  // `silent` parses too, but earns a warning of its own in the next test.
  for (const level of ["debug", "info", "warn", "error"]) {
    assert.deepEqual(
      validateConfig({ ...VALID_PRODUCTION, LOG_LEVEL: level }, { production: true }),
      [],
    );
  }
  assert.deepEqual(
    errors(
      validateConfig({ ...VALID_PRODUCTION, LOG_LEVEL: "silent" }, { production: true }),
    ),
    [],
  );
  const bad = validateConfig(
    { ...VALID_PRODUCTION, LOG_LEVEL: "verbose", LOG_FORMAT: "logfmt" },
    { production: true },
  );
  assert.deepEqual(variables(errors(bad)).sort(), ["LOG_FORMAT", "LOG_LEVEL"]);
  assert.match(errors(bad)[0].message, /debug, info, warn, error, silent/);
});

test("a production server that logs nothing, or logs for a human, is warned about", () => {
  const silent = validateConfig(
    { ...VALID_PRODUCTION, LOG_LEVEL: "silent" },
    { production: true },
  );
  assert.deepEqual(errors(silent), []);
  assert.deepEqual(variables(warnings(silent)), ["LOG_LEVEL"]);
  assert.match(warnings(silent)[0].message, /unhandled errors/);

  const pretty = validateConfig(
    { ...VALID_PRODUCTION, LOG_FORMAT: "pretty" },
    { production: true },
  );
  assert.deepEqual(variables(warnings(pretty)), ["LOG_FORMAT"]);

  // Both are the development defaults, so neither is worth saying there.
  assert.deepEqual(
    validateConfig(
      { LOG_LEVEL: "silent", LOG_FORMAT: "pretty" },
      { production: false },
    ).filter((p) => p.variable.startsWith("LOG_")),
    [],
  );
});
