import { z } from "zod";
import { parseCidr } from "@/lib/cidr";
import { resolveTimeExpr, resolveTimeRange } from "@/lib/time";

/**
 * Centralized, environment-driven configuration.
 *
 * All tunable defaults live here so that behaviour (refresh cadence, default
 * time range, query limits, AI provider selection) is environment configurable
 * rather than hard-coded across the codebase.
 */

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "true";
}

export const config = {
  /**
   * Default dashboard refresh cadence. A dashboard may override this per its
   * own IR, but new dashboards start from this value. Documented default: 15s.
   */
  defaultRefreshIntervalMs: num("DEFAULT_REFRESH_INTERVAL_MS", 15_000),
  /** Minimum refresh cadence enforced server-side to protect the metrics store. */
  minRefreshIntervalMs: num("MIN_REFRESH_INTERVAL_MS", 2_000),

  /**
   * Default relative time range applied to new dashboards. Documented default:
   * last 24 hours ("now-24h" .. "now").
   */
  defaultTimeFrom: str("DEFAULT_TIME_FROM", "now-24h"),
  /** Upper bound of the default range. `now` keeps new dashboards live. */
  defaultTimeTo: str("DEFAULT_TIME_TO", "now"),

  /** Hard cap on rows returned by any query executed against the metrics store. */
  maxQueryRows: num("MAX_QUERY_ROWS", 5_000),
  /**
   * Hard cap on the serialized size (bytes of JSON) of any query result. Rows
   * are a poor proxy for memory; a result over this fails with a 400 naming
   * the limit before it is fully buffered. Default 4 MiB.
   */
  maxResultBytes: num("MAX_RESULT_BYTES", 4 * 1024 * 1024),
  /** Max points retained per series in the browser rolling window. */
  maxWindowPoints: num("MAX_WINDOW_POINTS", 720),
  /** Statement timeout (seconds) applied to every metrics query. */
  queryTimeoutSeconds: num("QUERY_TIMEOUT_SECONDS", 20),

  /**
   * How long the server may take to drain after SIGTERM: pollers stop, SSE
   * subscribers are handed a reconnect hint, in-flight queries are awaited,
   * and the pools are closed. Keep it below the orchestrator's own kill
   * timeout (`terminationGracePeriodSeconds`, `stop_grace_period`) or the
   * process is killed mid-drain. Documented default: 10s.
   */
  shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 10_000),

  /**
   * The AI model id used for generation, surfaced read-only to the UI so users
   * can see which model produced their specs. Empty when unconfigured. This is
   * a display label only — actual provider/model resolution lives in
   * src/lib/ai/provider.ts.
   */
  aiModel: str("AI_MODEL", ""),

  /**
   * Model requests per minute allowed per user in a workspace, on every
   * LLM-backed route (generate, source draft, dashboard chat). A token bucket:
   * this is both the sustained rate and the burst size. `0` disables the
   * limit. Overridable per workspace in the `workspace_limits` table.
   */
  llmRatePerMinute: num("LLM_RATE_PER_MINUTE", 20),
  /**
   * Input plus output tokens a workspace may spend per UTC day across every
   * LLM-backed route. Requests over budget get a 429 until midnight UTC. `0`
   * disables the limit. Overridable per workspace in `workspace_limits`.
   */
  llmDailyTokenBudget: num("LLM_DAILY_TOKEN_BUDGET", 2_000_000),

  /** Cookie name used for the session JWT. */
  sessionCookieName: str("SESSION_COOKIE_NAME", "holotable_session"),

  /**
   * Send the Content-Security-Policy as `Content-Security-Policy-Report-Only`,
   * so the browser logs violations without blocking anything. For rolling the
   * policy out against a deployment; leave `false` once the console is clean.
   */
  cspReportOnly: bool("CSP_REPORT_ONLY", false),

  isProduction: process.env.NODE_ENV === "production",
} as const;

export type AppConfig = typeof config;

/* -------------------------------------------------------------------------- */
/* Startup validation                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The environment, validated as a whole so a misconfigured deployment refuses
 * to boot with every problem listed at once instead of failing at the first
 * generate request, the first query, or the first login.
 *
 * `validateConfig` is pure: it reads the map it is given and returns problems.
 * `src/lib/startup.ts` runs it from `instrumentation.ts` at server start and
 * from `npm run config:check`; that layer decides what to do with the result.
 *
 * Severity. An `error` refuses to boot. A `warning` is printed and ignored.
 * Values that are wrong in every environment (a URL that does not parse, an
 * unknown `AI_PROVIDER`, a minimum above a default) are always errors. Values
 * that are merely missing are errors in production and warnings in
 * development, so that an `.env` copied from `.env.example` still starts the
 * dev server while a production deployment cannot boot green and then fail in
 * front of a user.
 */

export type ConfigSeverity = "error" | "warning";

export interface ConfigProblem {
  /** The environment variable at fault. */
  variable: string;
  /** What is wrong and what to do, in one sentence. */
  message: string;
  severity: ConfigSeverity;
}

export interface ValidateConfigOptions {
  /**
   * Apply production requirements: missing values become errors. Defaults to
   * `NODE_ENV === "production"` of the environment being validated.
   */
  production?: boolean;
}

/** A read-only view of `process.env`, so tests can pass a plain object. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** `.env.example` ships this placeholder; running on it in production is fatal. */
const PLACEHOLDER_SESSION_SECRETS = new Set([
  "change-me-to-a-random-secret-of-32-characters",
  "dev-insecure-session-secret",
]);
const MIN_SESSION_SECRET_LENGTH = 32;
/** A 32+ char secret drawn from fewer than this many distinct characters is a keyboard mash, not a key. */
const MIN_SESSION_SECRET_DISTINCT_CHARS = 8;
/** Below this, a scrape token is guessable. A warning, not a refusal: it guards metrics, not data. */
const MIN_METRICS_TOKEN_LENGTH = 24;

/** Treat an empty string as unset, the way `num()`/`str()` above do. */
const blank = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const httpUrl = (what: string) =>
  z.url({
    protocol: /^https?$/,
    error: `must be an absolute http(s) URL (${what})`,
  });

const positiveInt = z.coerce
  .number({ error: "must be a positive integer" })
  .int("must be a positive integer")
  .positive("must be a positive integer");

const nonNegativeInt = z.coerce
  .number({ error: "must be a non-negative integer (0 disables the limit)" })
  .int("must be a non-negative integer (0 disables the limit)")
  .nonnegative("must be a non-negative integer (0 disables the limit)");

const timeExpr = z.string().refine(
  (v) => {
    try {
      resolveTimeExpr(v);
      return true;
    } catch {
      return false;
    }
  },
  { error: 'must be a relative expression like "now-1h" or "now", or an ISO timestamp' },
);

/**
 * Shape checks: each variable on its own, independent of the environment
 * type. Presence and cross-variable rules live in {@link validateConfig}.
 */
const EnvSchema = z.object({
  DATABASE_URL: blank(
    z.url({
      protocol: /^postgres(ql)?$/,
      error: "must be a postgresql:// connection URL",
    }),
  ),
  PG_POOL_MAX: blank(positiveInt),

  APP_VERSION: blank(z.string()),
  GIT_COMMIT: blank(z.string()),

  SESSION_SECRET: blank(z.string()),
  SESSION_COOKIE_NAME: blank(
    z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, "must be a valid cookie name (letters, digits, _ or -)"),
  ),
  CSP_REPORT_ONLY: blank(
    z.enum(["true", "false"], { error: 'must be "true" or "false"' }),
  ),

  // Spelled out rather than imported from `src/lib/log.ts`: this module is
  // reachable from the browser bundle and that one imports `node:async_hooks`.
  // `test/log.test.ts` fails if the two vocabularies drift apart.
  LOG_LEVEL: blank(
    z.enum(["debug", "info", "warn", "error", "silent"], {
      error: "must be one of debug, info, warn, error, silent",
    }),
  ),
  LOG_FORMAT: blank(
    z.enum(["json", "pretty"], {
      error: 'must be "json" (one object per line) or "pretty" (human-readable)',
    }),
  ),

  METRICS_TOKEN: blank(z.string()),
  METRICS_ALLOWED_CIDRS: blank(
    z.string().refine(
      (v) =>
        v
          .split(/[,\s]+/)
          .filter(Boolean)
          .every((e) => parseCidr(e) !== null),
      {
        error:
          "must be a comma-separated list of IPv4/IPv6 addresses or CIDR ranges, e.g. 10.0.0.0/8,::1",
      },
    ),
  ),

  AI_PROVIDER: blank(
    z.enum(["gateway", "openai-compatible"], {
      error: 'must be "gateway" or "openai-compatible"',
    }),
  ),
  AI_MODEL: blank(z.string()),
  OPENAI_API: blank(
    z.enum(["chat", "responses"], {
      error: 'must be "chat" (Chat Completions) or "responses" (Responses API), or unset',
    }),
  ),
  OPENAI_BASE_URL: blank(
    httpUrl("the provider endpoint, e.g. https://openrouter.ai/api/v1"),
  ),
  OPENAI_API_KEY: blank(z.string()),
  AI_GATEWAY_API_KEY: blank(z.string()),
  LLM_RATE_PER_MINUTE: blank(nonNegativeInt),
  LLM_DAILY_TOKEN_BUDGET: blank(nonNegativeInt),

  OIDC_ISSUER: blank(
    httpUrl("the realm issuer, e.g. https://kc.example.com/realms/holotable"),
  ),
  OIDC_CLIENT_ID: blank(z.string()),
  OIDC_CLIENT_SECRET: blank(z.string()),
  OIDC_REDIRECT_URI: blank(httpUrl("this app's /api/auth/callback")),
  OIDC_JWKS_URL: blank(httpUrl("the realm's JWKS endpoint")),
  OIDC_GROUPS_CLAIM: blank(z.string()),
  OIDC_SCOPE: blank(
    z
      .string()
      .refine(
        (v) => v.split(/\s+/).includes("openid"),
        'must include the "openid" scope',
      ),
  ),
  OIDC_AUDIENCE: blank(z.string()),

  DEFAULT_REFRESH_INTERVAL_MS: blank(positiveInt),
  MIN_REFRESH_INTERVAL_MS: blank(positiveInt),
  DEFAULT_TIME_FROM: blank(timeExpr),
  DEFAULT_TIME_TO: blank(timeExpr),
  MAX_QUERY_ROWS: blank(positiveInt),
  MAX_RESULT_BYTES: blank(positiveInt),
  MAX_WINDOW_POINTS: blank(positiveInt),
  QUERY_TIMEOUT_SECONDS: blank(positiveInt),
  SHUTDOWN_GRACE_MS: blank(positiveInt),
});

type Env = z.infer<typeof EnvSchema>;

/** Validate the environment. Returns every problem found; an empty list means boot. */
export function validateConfig(
  env: Environment = process.env,
  opts: ValidateConfigOptions = {},
): ConfigProblem[] {
  const production = opts.production ?? env.NODE_ENV === "production";
  const problems: ConfigProblem[] = [];
  const error = (variable: string, message: string) =>
    problems.push({ variable, message, severity: "error" });
  const warning = (variable: string, message: string) =>
    problems.push({ variable, message, severity: "warning" });
  /** Missing values: fatal in production, advisory in development. */
  const missing = (variable: string, message: string) =>
    (production ? error : warning)(variable, message);

  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      error(String(issue.path[0] ?? "?"), issue.message);
    }
  }
  // Fields that failed shape validation are absent from `values`; every rule
  // below treats an absent field as unset, so a malformed value is reported
  // once (for its shape) rather than twice.
  const values: Partial<Env> = parsed.success ? parsed.data : partialParse(env);

  // --- Config store -------------------------------------------------------
  if (!values.DATABASE_URL) {
    missing(
      "DATABASE_URL",
      "is not set; the config store (workspaces, sources, dashboards) cannot be reached. Set it to the postgresql:// URL of the Holotable database.",
    );
  }

  // --- Session signing key ------------------------------------------------
  const secret = values.SESSION_SECRET;
  if (!secret) {
    missing(
      "SESSION_SECRET",
      production
        ? `is not set. Set it to a random value of at least ${MIN_SESSION_SECRET_LENGTH} characters; sessions cannot be signed without it.`
        : "is not set; the insecure development fallback key will sign sessions. Set a random value before exposing this server.",
    );
  } else if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    missing(
      "SESSION_SECRET",
      `is ${secret.length} characters; it must be at least ${MIN_SESSION_SECRET_LENGTH}. Generate one with \`openssl rand -base64 32\`.`,
    );
  } else if (production && PLACEHOLDER_SESSION_SECRETS.has(secret)) {
    error(
      "SESSION_SECRET",
      "is the placeholder from .env.example, which is public. Generate a unique value with `openssl rand -base64 32`.",
    );
  } else if (production && new Set(secret).size < MIN_SESSION_SECRET_DISTINCT_CHARS) {
    error(
      "SESSION_SECRET",
      `uses fewer than ${MIN_SESSION_SECRET_DISTINCT_CHARS} distinct characters and is guessable. Generate one with \`openssl rand -base64 32\`.`,
    );
  }

  // --- Security headers ---------------------------------------------------
  // Report-only is a rollout tool. In production it means the policy that
  // protects users is being logged, not enforced, so say so at every boot.
  if (production && values.CSP_REPORT_ONLY === "true") {
    warning(
      "CSP_REPORT_ONLY",
      "is true; the Content-Security-Policy is reported, not enforced. Set it to false once the browser console shows no violations.",
    );
  }

  // --- Logging ------------------------------------------------------------
  // Both have a working default in every environment, so neither is ever
  // missing. What is worth saying at boot is that this deployment has chosen
  // to throw its own record away, or to emit something no aggregator parses.
  if (production && values.LOG_LEVEL === "silent") {
    warning(
      "LOG_LEVEL",
      "is silent; this server will write no log at all, including unhandled errors. Set it to info unless something else is capturing them.",
    );
  }
  if (production && values.LOG_FORMAT === "pretty") {
    warning(
      "LOG_FORMAT",
      "is pretty; lines are written for a human to read and a log aggregator will not parse them as JSON. Leave it unset in production.",
    );
  }

  // --- Metrics endpoint ---------------------------------------------------
  // `/api/metrics` is closed until one of these is set, so an unset pair is
  // not a problem — it is the default. What is worth saying at boot is that a
  // CIDR allowlist on its own trusts a header, and a short bearer token is
  // not much of a secret.
  const metricsToken = values.METRICS_TOKEN;
  const metricsCidrs = values.METRICS_ALLOWED_CIDRS;
  if (production && metricsCidrs && !metricsToken) {
    warning(
      "METRICS_ALLOWED_CIDRS",
      "is set without METRICS_TOKEN; the address check reads X-Forwarded-For and is only meaningful behind a proxy that sets it. Set METRICS_TOKEN unless this app is never reachable directly.",
    );
  }
  if (production && metricsToken && metricsToken.length < MIN_METRICS_TOKEN_LENGTH) {
    warning(
      "METRICS_TOKEN",
      `is ${metricsToken.length} characters; a scrape token should be at least ${MIN_METRICS_TOKEN_LENGTH}. Generate one with \`openssl rand -hex 32\`.`,
    );
  }

  // --- AI provider --------------------------------------------------------
  if (!values.AI_MODEL) {
    missing(
      "AI_MODEL",
      "is not set; every generate request would fail. Set the model id for your AI_PROVIDER (see .env.example).",
    );
  }
  const provider = values.AI_PROVIDER ?? "openai-compatible";
  if (provider === "openai-compatible" && !values.OPENAI_API_KEY) {
    missing(
      "OPENAI_API_KEY",
      "is not set but AI_PROVIDER is openai-compatible; the provider will reject every request. Set the API key for OPENAI_BASE_URL.",
    );
  }
  if (provider === "gateway" && !values.AI_GATEWAY_API_KEY) {
    missing(
      "AI_GATEWAY_API_KEY",
      "is not set but AI_PROVIDER is gateway; the gateway will reject every request.",
    );
  }
  if (provider === "gateway" && values.OPENAI_API) {
    warning("OPENAI_API", "is ignored when AI_PROVIDER is gateway.");
  }

  // --- LLM limits ---------------------------------------------------------
  // A disabled ceiling is a choice, but in production it is one worth seeing
  // at every boot: an authenticated user can then spend without bound.
  if (production && values.LLM_RATE_PER_MINUTE === 0) {
    warning(
      "LLM_RATE_PER_MINUTE",
      "is 0; model requests are not rate limited. Set a per-user requests-per-minute ceiling.",
    );
  }
  if (production && values.LLM_DAILY_TOKEN_BUDGET === 0) {
    warning(
      "LLM_DAILY_TOKEN_BUDGET",
      "is 0; workspaces have no daily token budget and provider spend is unbounded. Set a per-workspace tokens-per-day ceiling.",
    );
  }

  // --- OIDC ---------------------------------------------------------------
  // Keycloak is the only way to sign in, so in production the confidential
  // client must be configured completely. OIDC_REDIRECT_URI is optional: it
  // is derived from the request origin when unset.
  const oidcRequired: Array<[keyof Env, string]> = [
    ["OIDC_ISSUER", "the realm URL; login and token verification both need it"],
    ["OIDC_CLIENT_ID", "the Keycloak client id; login cannot start without it"],
    [
      "OIDC_CLIENT_SECRET",
      "the confidential client's secret; the code exchange fails without it",
    ],
    [
      "OIDC_JWKS_URL",
      "the realm's JWKS endpoint; Keycloak-issued tokens cannot be verified without it",
    ],
  ];
  for (const [variable, why] of oidcRequired) {
    if (values[variable]) continue;
    if (production) {
      error(variable, `is not set: ${why}. See docs/operations/keycloak.`);
    } else if (variable === "OIDC_ISSUER" || variable === "OIDC_CLIENT_ID") {
      warning(variable, `is not set; sign-in will fail until it is (${why}).`);
    }
  }
  if (values.OIDC_ISSUER && values.OIDC_JWKS_URL) {
    const issuer = new URL(values.OIDC_ISSUER);
    const jwks = new URL(values.OIDC_JWKS_URL);
    if (issuer.origin !== jwks.origin) {
      warning(
        "OIDC_JWKS_URL",
        `is served from ${jwks.origin} while OIDC_ISSUER is ${issuer.origin}; Keycloak publishes the JWKS under the issuer at /protocol/openid-connect/certs. Check for a copy-paste mismatch.`,
      );
    }
  }

  // --- Dashboard and query defaults --------------------------------------
  const min = values.MIN_REFRESH_INTERVAL_MS ?? config.minRefreshIntervalMs;
  const def = values.DEFAULT_REFRESH_INTERVAL_MS ?? config.defaultRefreshIntervalMs;
  if (min > def) {
    error(
      "MIN_REFRESH_INTERVAL_MS",
      `is ${min}, above DEFAULT_REFRESH_INTERVAL_MS (${def}); the minimum would override the default on every dashboard.`,
    );
  }
  const from = values.DEFAULT_TIME_FROM ?? config.defaultTimeFrom;
  const to = values.DEFAULT_TIME_TO ?? config.defaultTimeTo;
  if (values.DEFAULT_TIME_FROM !== undefined || values.DEFAULT_TIME_TO !== undefined) {
    try {
      resolveTimeRange({ from, to });
    } catch {
      error(
        "DEFAULT_TIME_FROM",
        `"${from}" is not before DEFAULT_TIME_TO "${to}"; the default range would be empty.`,
      );
    }
  }

  return problems;
}

/**
 * When the schema as a whole fails, recover the fields that did parse so the
 * presence rules can still run on them. Zod stops at the object level, so
 * this re-parses field by field.
 */
function partialParse(env: Environment): Partial<Env> {
  const out: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(EnvSchema.shape)) {
    const r = schema.safeParse(env[key]);
    if (r.success && r.data !== undefined) out[key] = r.data;
  }
  return out as Partial<Env>;
}

/**
 * Check that every registered source's `secret_ref` resolves to credentials.
 * Always a warning: sources are created at runtime, and a source whose
 * credentials arrive with the next deploy should not keep the whole server
 * from starting. The same failure still surfaces on Test and on execution.
 */
export function validateSourceSecrets(
  secretRefs: Iterable<string>,
  env: Environment = process.env,
): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  for (const ref of new Set(secretRefs)) {
    for (const suffix of ["_USERNAME", "_PASSWORD"] as const) {
      const variable = `${ref}${suffix}`;
      const value = env[variable];
      if (value === undefined || (suffix === "_USERNAME" && value === "")) {
        problems.push({
          variable,
          message: `is not set; a registered source uses secret_ref "${ref}" and will fail on Test and on every query until it is.`,
          severity: "warning",
        });
      }
    }
  }
  return problems;
}

/** Render problems as one multi-line report, errors first. */
export function formatConfigProblems(problems: readonly ConfigProblem[]): string {
  const errors = problems.filter((p) => p.severity === "error");
  const warnings = problems.filter((p) => p.severity === "warning");
  const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  const head =
    errors.length > 0
      ? `Configuration is invalid (${count(errors.length, "error")}, ${count(warnings.length, "warning")}); refusing to start.`
      : `Configuration has ${count(warnings.length, "warning")}.`;
  const line = (p: ConfigProblem) =>
    `  ${p.severity === "error" ? "error  " : "warning"}  ${p.variable}: ${p.message}`;
  return [head, ...errors.map(line), ...warnings.map(line)].join("\n");
}
