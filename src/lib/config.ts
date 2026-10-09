import { z } from "zod";
import {
  CLAIM_NAME,
  parseGroups,
  PLATFORM_ADMIN_GROUP,
  RESERVED_CLAIMS,
  splitClaimNames,
} from "@/lib/auth/claims";
import { isOrigin, splitOrigins } from "@/lib/auth/origin";
import { invalidAllowlistEntries } from "@/lib/ai/base-url";
import { parseCidr } from "@/lib/cidr";
import { SECRET_REF_GRANTS_VAR, parseSecretRefGrants } from "@/lib/secret-refs";
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

/** A single-unit duration, as `PROMQL_MAX_RANGE` takes one: `7d`, `12h`. */
const DURATION = /^(\d+)(ms|s|m|h|d|w)$/;

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

/** `AUTH_MODE` values. `oidc` is Keycloak, the default and the only real one. */
export const AUTH_MODES = ["oidc", "demo"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** What a demo visitor is granted when `DEMO_GROUPS` is unset. */
export const DEFAULT_DEMO_GROUPS = "/workspaces/demo/editor";

/** `DEMO_GROUPS` as group paths: comma- or whitespace-separated. */
export function splitGroups(raw: string): string[] {
  return raw.split(/[\s,]+/).filter(Boolean);
}

/**
 * Whether session cookies carry `Secure`: `SESSION_COOKIE_SECURE` when set,
 * otherwise production. A browser drops a `Secure` cookie on plain `http://`
 * (Safari even on localhost, every browser on a LAN address), so the quick-start
 * image, which serves plain HTTP in production mode, turns it off (#253).
 */
export function cookieSecure(env: Environment): boolean {
  const raw = env.SESSION_COOKIE_SECURE;
  if (raw === "true") return true;
  if (raw === "false") return false;
  return env.NODE_ENV === "production";
}

/**
 * The names of the cookies the app sets (#26). A `Secure` cookie gets a
 * prefix the browser enforces: `__Host-` means it was set over HTTPS with
 * `Path=/` and no `Domain`, so a sibling subdomain cannot plant or overwrite
 * it. The renewal cookie is scoped to `/api/auth`, which `__Host-` forbids, so
 * it gets `__Secure-`, which requires only `Secure`. Without `Secure` (plain
 * HTTP in development, or the quick-start image) the browser would refuse a
 * prefixed cookie outright, so the names stay bare.
 */
export function cookieNames(base: string, secure: boolean) {
  const host = (name: string) => (secure ? `__Host-${name}` : name);
  return {
    session: host(base),
    renew: secure ? `__Secure-${base}_renew` : `${base}_renew`,
    oidcState: host("holotable_oidc_state"),
    oidcNonce: host("holotable_oidc_nonce"),
    oidcVerifier: host("holotable_oidc_verifier"),
  };
}

const COOKIES = cookieNames(
  str("SESSION_COOKIE_NAME", "holotable_session"),
  cookieSecure(process.env),
);

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
   * Consecutive failed executions before the poller stops running a panel on
   * every tick and backs off (#44).
   */
  pollerFailureThreshold: num("POLLER_FAILURE_THRESHOLD", 3),
  /** The longest the poller waits between attempts at a failing panel (#44). */
  pollerMaxBackoffMs: num("POLLER_MAX_BACKOFF_MS", 300_000),

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
  /**
   * The longest range, subquery range or offset a PromQL expression may ask
   * for (#384), so one selector cannot ask the endpoint for a year. A
   * duration such as `7d` or `12h`.
   */
  promqlMaxRange: str("PROMQL_MAX_RANGE", "7d"),
  /** Max points retained per series in the browser rolling window. */
  maxWindowPoints: num("MAX_WINDOW_POINTS", 720),
  /** Statement timeout (seconds) applied to every metrics query. */
  queryTimeoutSeconds: num("QUERY_TIMEOUT_SECONDS", 20),
  /**
   * Most connections this process holds open to any one metrics source (#13).
   * Executions beyond it wait for a free connection, for up to the query
   * timeout plus five seconds.
   */
  maxPoolPerSource: num("MAX_POOL_PER_SOURCE", 5),

  /**
   * How long a source's catalog may go without being checked against the live
   * database before it is reported as stale. Stale is a warning, not a refusal
   * — a catalog nobody has refreshed *at all* is what blocks generation. `0`
   * disables the age check entirely. Documented default: 30 days.
   */
  catalogStaleAfterDays: num("CATALOG_STALE_AFTER_DAYS", 30),

  /**
   * How long the server may take to drain after SIGTERM: pollers stop, SSE
   * subscribers are handed a reconnect hint, in-flight queries are awaited,
   * and the pools are closed. Keep it below the orchestrator's own kill
   * timeout (`terminationGracePeriodSeconds`, `stop_grace_period`) or the
   * process is killed mid-drain. Documented default: 10s.
   */
  shutdownGraceMs: num("SHUTDOWN_GRACE_MS", 10_000),

  /**
   * How often an open dashboard stream verifies its session token again and
   * re-authorizes the dashboard as it is now (#32), so a dashboard deleted or
   * moved out of the viewer's workspaces stops streaming within this long. A
   * stream also ends at its token's expiry and on revocation, whatever this
   * is. Documented default: 60s.
   */
  sseReauthIntervalMs: num("SSE_REAUTH_INTERVAL_MS", 60_000),

  /**
   * The longest a service-account API token may live, in days (#288). Every
   * token has an expiry, and this caps it, so a forgotten one runs out.
   * Documented default: 90.
   */
  apiTokenMaxDays: num("API_TOKEN_MAX_DAYS", 90),

  /**
   * The AI model id used for generation, surfaced read-only to the UI so users
   * can see which model produced their specs. Empty when unconfigured. This is
   * a display label only — actual provider/model resolution lives in
   * src/lib/ai/provider.ts.
   */
  aiModel: str("AI_MODEL", ""),

  /**
   * The deadline for one model request, retries and backoff waits included
   * (#22). Keep it below the generate and chat routes' 60s `maxDuration`, or
   * the platform cuts the response first, with no error. Documented default:
   * 45s.
   */
  aiRequestTimeoutMs: num("AI_REQUEST_TIMEOUT_MS", 45_000),
  /**
   * How many times a model request is retried after a transient provider
   * failure (429, 5xx, a dropped connection), with jittered exponential
   * backoff. A 401 or 404 is never retried. `0` disables retrying. Documented
   * default: 2.
   */
  aiMaxRetries: num("AI_MAX_RETRIES", 2),
  /**
   * Hosts and address ranges a model base URL entered in the app (#331) may
   * reach although they are not public, and hosts it may reach over plain
   * http: a local Ollama, a vLLM in the cluster. Comma-separated host names,
   * addresses and CIDR ranges. Empty by default, so an in-app base URL must be
   * public https. The environment's own OPENAI_BASE_URL is not held to it.
   */
  aiBaseUrlAllowlist: str("AI_BASE_URL_ALLOWLIST", ""),

  /**
   * Hosts, addresses and CIDR ranges a Prometheus source's URL may reach
   * although they are not public, and hosts it may reach over plain http
   * (#385). An in-cluster Prometheus (`prometheus.monitoring.svc`) is the
   * usual entry. Every workspace's source admins may point a source at an
   * address listed here, so an endpoint that must stay one tenant's needs
   * authentication and a granted secret_ref instead. Empty: a source URL must
   * be public https.
   */
  sourceUrlAllowlist: str("SOURCE_URL_ALLOWLIST", ""),
  /** The smallest step a Prometheus range query is sent with (#385). */
  prometheusMinStepMs: num("PROMETHEUS_MIN_STEP_MS", 15_000),
  /** The most points per series a Prometheus range query asks for (#385). */
  promqlMaxPoints: num("PROMQL_MAX_POINTS", 1_000),
  /**
   * The most series one Prometheus result may hold before it is refused as
   * the author's to narrow (#385). Each series becomes a column.
   */
  prometheusMaxSeries: num("PROMETHEUS_MAX_SERIES", 100),

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

  /**
   * How many messages of one person's chat history on one dashboard are kept
   * and replayed. The cap is enforced on write and on read, so lowering it
   * takes effect at once. Documented default: 100 messages.
   */
  chatHistoryMaxMessages: num("CHAT_HISTORY_MAX_MESSAGES", 100),
  /**
   * How long a stored chat message is kept. A conversation is a reader working
   * something out, not a record anyone audits, so it expires. `0` disables the
   * age check and leaves only the message cap. Documented default: 30 days.
   */
  chatHistoryRetentionDays: num("CHAT_HISTORY_RETENTION_DAYS", 30),

  /**
   * How long a `generation_log` row -- the redacted prompt, the spec the model
   * returned, and what it cost -- is kept. The sweep runs on write, so
   * shortening this takes effect at the next generation in that workspace and
   * immediately for anyone reading the log. `0` disables the age check and
   * lets the log grow without bound, which is for an operator shipping the
   * rows somewhere else. Documented default: 30 days.
   */
  generationLogRetentionDays: num("GENERATION_LOG_RETENTION_DAYS", 30),

  /**
   * The identity provider's self-service account page, e.g. Keycloak's
   * `<issuer>/account`. The account settings section links to it when set, so
   * people can change the name, email and password the provider owns. Unset
   * hides the link.
   */
  oidcAccountUrl: str("OIDC_ACCOUNT_URL", ""),

  /**
   * The realm client an MCP client signs in through (#149): a public (PKCE)
   * client beside the confidential one the browser uses, whose access tokens
   * name it in `aud` and `azp`. `/api/mcp` accepts a realm token only when it
   * was minted for this client, and no other route accepts one at all. Unset
   * (the default) keeps `/api/mcp` closed, and demo mode refuses it like every
   * other `OIDC_*` variable.
   */
  oidcMcpClientId: str("OIDC_MCP_CLIENT_ID", ""),

  /**
   * How people sign in (#251). `oidc` is Keycloak and the default. `demo` is
   * for evaluation and the public demo only: `/api/auth/login` mints a session
   * for every visitor with no login screen, holding {@link demoGroups}.
   * Anything but the exact string `demo` is `oidc`, so a typo fails closed
   * (and `validateConfig` refuses to boot on it). Server-only in practice:
   * the browser bundle has no `AUTH_MODE` and always reads `oidc`, so a client
   * component is handed the mode as a prop instead of reading it here.
   */
  authMode: (process.env.AUTH_MODE === "demo" ? "demo" : "oidc") as AuthMode,
  /**
   * The groups every demo visitor's session carries, in the same
   * `/workspaces/{id}/{role}` form as a Keycloak `groups` claim, parsed by the
   * same parser. Never source-admin, never platform admin: `validateConfig`
   * refuses both. Ignored unless {@link authMode} is `demo`.
   */
  demoGroups: splitGroups(str("DEMO_GROUPS", DEFAULT_DEMO_GROUPS)),

  /**
   * Realm claims carried from the id_token into the session (#31), for a
   * source's row filter to read: `rowFilter.claim` names one of these, or
   * `sub`. Comma- or whitespace-separated. Empty (the default) carries none,
   * and a source that filters on anything but `sub` then refuses every query.
   */
  rowFilterClaims: splitClaimNames(str("ROW_FILTER_CLAIMS", "")),

  /**
   * Origins besides this app's own that may send it a state-changing request
   * with the session cookie (#25). Exact origins, comma- or
   * whitespace-separated; empty (the default) allows only the app itself.
   */
  allowedOrigins: splitOrigins(str("ALLOWED_ORIGINS", "")),

  /**
   * Cookie name used for the session JWT: `SESSION_COOKIE_NAME`, with
   * `__Host-` in front when the cookie is `Secure` (#26).
   */
  sessionCookieName: COOKIES.session,
  /** The renewal cookie (#27), `__Secure-` prefixed when `Secure`. */
  renewCookieName: COOKIES.renew,
  /** The sign-in handshake's state, nonce and PKCE verifier cookies. */
  oidcStateCookieName: COOKIES.oidcState,
  oidcNonceCookieName: COOKIES.oidcNonce,
  /** The sign-in's PKCE code verifier (#281). */
  oidcVerifierCookieName: COOKIES.oidcVerifier,
  /** Whether the session and sign-in cookies are `Secure`; see {@link cookieSecure}. */
  sessionCookieSecure: cookieSecure(process.env),

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

/**
 * The `maxDuration` of the model-backed routes (`/api/generate`,
 * `/api/sources/generate`, the dashboard chat), in milliseconds.
 * `test/config.test.ts` holds it to the routes.
 */
export const AI_ROUTE_MAX_DURATION_MS = 60_000;

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
      .regex(/^[A-Za-z0-9_-]+$/, "must be a valid cookie name (letters, digits, _ or -)")
      .refine((name) => !/^__(host|secure)-/i.test(name), {
        message:
          "must not start with __Host- or __Secure-: the prefix is added for you when the cookie is Secure",
      }),
  ),
  SESSION_COOKIE_SECURE: blank(
    z.enum(["true", "false"], { error: 'must be "true" or "false"' }),
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
    z.enum(["gateway", "openai-compatible", "stub"], {
      error: 'must be "gateway", "openai-compatible" or "stub"',
    }),
  ),
  AI_STUB_IN_PRODUCTION: blank(
    z.enum(["true", "false"], { error: 'must be "true" or "false"' }),
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
  AI_REQUEST_TIMEOUT_MS: blank(positiveInt),
  AI_MAX_RETRIES: blank(
    z.coerce
      .number({ error: "must be an integer from 0 to 10 (0 disables retrying)" })
      .int("must be an integer from 0 to 10 (0 disables retrying)")
      .min(0, "must be an integer from 0 to 10 (0 disables retrying)")
      .max(10, "must be an integer from 0 to 10 (0 disables retrying)"),
  ),
  AI_BASE_URL_ALLOWLIST: blank(
    z.string().refine((v) => invalidAllowlistEntries(v).length === 0, {
      error:
        "must be a comma-separated list of host names, addresses and CIDR ranges, e.g. ollama.internal,10.0.0.0/8",
    }),
  ),
  SOURCE_URL_ALLOWLIST: blank(
    z.string().refine((v) => invalidAllowlistEntries(v).length === 0, {
      error:
        "must be a comma-separated list of host names, addresses and CIDR ranges, e.g. prometheus.monitoring.svc,10.0.0.0/8",
    }),
  ),
  PROMETHEUS_MIN_STEP_MS: blank(positiveInt),
  PROMQL_MAX_POINTS: blank(positiveInt),
  PROMETHEUS_MAX_SERIES: blank(positiveInt),
  LLM_RATE_PER_MINUTE: blank(nonNegativeInt),
  LLM_DAILY_TOKEN_BUDGET: blank(nonNegativeInt),

  AUTH_MODE: blank(
    z.enum(AUTH_MODES, {
      error: 'must be "oidc" (Keycloak, the default) or "demo" (evaluation only)',
    }),
  ),
  DEMO_GROUPS: blank(z.string()),
  ROW_FILTER_CLAIMS: blank(z.string()),
  ALLOWED_ORIGINS: blank(z.string()),

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
  OIDC_ACCOUNT_URL: blank(
    httpUrl("the identity provider's account page, e.g. <issuer>/account"),
  ),
  OIDC_MCP_CLIENT_ID: blank(z.string()),

  DEFAULT_REFRESH_INTERVAL_MS: blank(positiveInt),
  MIN_REFRESH_INTERVAL_MS: blank(positiveInt),
  POLLER_FAILURE_THRESHOLD: blank(positiveInt),
  POLLER_MAX_BACKOFF_MS: blank(positiveInt),
  DEFAULT_TIME_FROM: blank(timeExpr),
  DEFAULT_TIME_TO: blank(timeExpr),
  MAX_QUERY_ROWS: blank(positiveInt),
  MAX_RESULT_BYTES: blank(positiveInt),
  PROMQL_MAX_RANGE: blank(
    z
      .string()
      .regex(DURATION, "must be a duration such as 7d or 12h")
      .refine(
        (v) => !DURATION.test(v) || Number(DURATION.exec(v)?.[1]) > 0,
        "must be longer than zero",
      ),
  ),
  MAX_WINDOW_POINTS: blank(positiveInt),
  QUERY_TIMEOUT_SECONDS: blank(positiveInt),
  MAX_POOL_PER_SOURCE: blank(positiveInt),
  CATALOG_STALE_AFTER_DAYS: blank(nonNegativeInt),
  CHAT_HISTORY_MAX_MESSAGES: blank(positiveInt),
  CHAT_HISTORY_RETENTION_DAYS: blank(nonNegativeInt),
  GENERATION_LOG_RETENTION_DAYS: blank(nonNegativeInt),
  SHUTDOWN_GRACE_MS: blank(positiveInt),
  SSE_REAUTH_INTERVAL_MS: blank(positiveInt),
  API_TOKEN_MAX_DAYS: blank(positiveInt),

  // Not `blank()`: the empty string is a real declaration here ("no source
  // may resolve credentials yet"), distinct from the variable being unset.
  SOURCE_SECRET_REFS: z
    .string()
    .optional()
    .superRefine((v, ctx) => {
      if (v === undefined) return;
      const parsed = parseSecretRefGrants(v);
      if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
    }),
  SOURCE_SECRETS_DIR: blank(z.string().startsWith("/", "must be an absolute path")),
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
  const demo = values.AUTH_MODE === "demo";

  // --- Config store -------------------------------------------------------
  if (!values.DATABASE_URL) {
    missing(
      "DATABASE_URL",
      "is not set; the config store (workspaces, sources, dashboards) cannot be reached. Set it to the postgresql:// URL of the Holotable database.",
    );
  }

  // --- Source credential grants -------------------------------------------
  // Fail closed: unset grants no workspace any secret_ref, so every source
  // stops resolving credentials. In production that is refused at boot rather
  // than discovered one failed panel at a time.
  if (env[SECRET_REF_GRANTS_VAR] === undefined) {
    missing(
      SECRET_REF_GRANTS_VAR,
      'is not set, so no source can resolve credentials. Declare which workspaces may use each secret_ref, e.g. "TS_METRICS:demo,ops; BILLING_RO:finance" ("*" grants every workspace), or set it empty if no source is configured yet.',
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

  // A session cookie without `Secure` can be read off any plain-HTTP hop. The
  // quick-start image sets this on purpose and runs in demo mode, where there
  // is nothing worth stealing; a real deployment should hear about it.
  if (
    production &&
    values.SESSION_COOKIE_SECURE === "false" &&
    values.AUTH_MODE !== "demo"
  ) {
    warning(
      "SESSION_COOKIE_SECURE",
      "is false; session cookies will be sent over plain HTTP. Serve the app over HTTPS and leave it unset.",
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
  // In demo mode the model is optional: the seeded dashboards, the viewer and
  // the SQL editor need no key, and the generate, chat and Explore pages say
  // what is missing instead of failing a request (src/lib/ai/configured.ts).
  const aiMissing = demo ? warning : missing;
  const provider = values.AI_PROVIDER ?? "openai-compatible";
  // The recorded model (#88, src/lib/ai/stub.ts) answers every prompt with the
  // same spec. It is for the end-to-end suite, which runs a production build;
  // anywhere else in production it would be a deployment that forgot to
  // configure a model and boots green anyway, so it has to be asked for twice.
  if (provider === "stub") {
    if (production && values.AI_STUB_IN_PRODUCTION !== "true") {
      error(
        "AI_PROVIDER",
        'is "stub", which answers with recorded specs and never calls a model. It is for the end-to-end suite; set AI_STUB_IN_PRODUCTION=true if that is what this server is, or configure a real provider.',
      );
    } else {
      warning(
        "AI_PROVIDER",
        'is "stub"; generation answers with recorded specs and never calls a model.',
      );
    }
  } else if (!values.AI_MODEL) {
    aiMissing(
      "AI_MODEL",
      "is not set; every generate request would fail. Set the model id for your AI_PROVIDER (see .env.example).",
    );
  }
  if (provider === "openai-compatible" && !values.OPENAI_API_KEY) {
    aiMissing(
      "OPENAI_API_KEY",
      "is not set but AI_PROVIDER is openai-compatible; the provider will reject every request. Set the API key for OPENAI_BASE_URL.",
    );
  }
  if (provider === "gateway" && !values.AI_GATEWAY_API_KEY) {
    aiMissing(
      "AI_GATEWAY_API_KEY",
      "is not set but AI_PROVIDER is gateway; the gateway will reject every request.",
    );
  }
  if (provider === "gateway" && values.OPENAI_API) {
    warning("OPENAI_API", "is ignored when AI_PROVIDER is gateway.");
  }

  // The generate and chat routes export `maxDuration = 60`; past it the
  // platform ends the response with no error, so a deadline that long never
  // gets to report a timeout.
  if (
    values.AI_REQUEST_TIMEOUT_MS !== undefined &&
    values.AI_REQUEST_TIMEOUT_MS >= AI_ROUTE_MAX_DURATION_MS
  ) {
    warning(
      "AI_REQUEST_TIMEOUT_MS",
      `is ${values.AI_REQUEST_TIMEOUT_MS}; the generate and chat routes end at ${AI_ROUTE_MAX_DURATION_MS}ms, so a hung model would be cut off without an error. Set it below that, e.g. 45000.`,
    );
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

  // --- Demo mode ----------------------------------------------------------
  // The one exception to "Keycloak is the only way in" (#251), fenced so it is
  // useless for anything but evaluation. Every visitor gets a session holding
  // DEMO_GROUPS with no login, so the groups must never reach source-admin (a
  // visitor could register a source pointing at any host this server can
  // reach) or platform admin, and the mode must never share a deployment with
  // a real realm, where it would hand out sessions beside real ones.
  const oidcVariables = [
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_JWKS_URL",
    "OIDC_MCP_CLIENT_ID",
  ] as const;
  if (demo) {
    for (const variable of oidcVariables) {
      if (env[variable]) {
        error(
          variable,
          "is set while AUTH_MODE is demo. Demo mode hands every visitor a session without a login and must never run beside a real identity provider; unset it, or set AUTH_MODE=oidc.",
        );
      }
    }
    const groups = splitGroups(values.DEMO_GROUPS ?? DEFAULT_DEMO_GROUPS);
    const identity = parseGroups("demo", groups);
    if (identity.platformAdmin || groups.includes(PLATFORM_ADMIN_GROUP)) {
      error(
        "DEMO_GROUPS",
        `contains ${PLATFORM_ADMIN_GROUP}; a demo visitor must never be a platform admin. Grant /workspaces/<id>/viewer or /workspaces/<id>/editor.`,
      );
    }
    const admin = Object.entries(identity.workspaces).find(
      ([, role]) => role === "source-admin",
    );
    if (admin) {
      error(
        "DEMO_GROUPS",
        `grants source-admin on workspace "${admin[0]}"; a demo visitor could then register a source pointing at any host this server can reach. Use viewer or editor.`,
      );
    } else if (!identity.platformAdmin && Object.keys(identity.workspaces).length === 0) {
      error(
        "DEMO_GROUPS",
        "grants no workspace role, so every demo visitor would see an empty app. Use paths like /workspaces/demo/editor.",
      );
    }
  } else if (env.DEMO_GROUPS) {
    warning("DEMO_GROUPS", "is set but ignored unless AUTH_MODE=demo.");
  }

  // --- Row-filter claims (#31) ---------------------------------------------
  // Each name is written back into the first-party session token beside the
  // claims it already uses, so one of those names would overwrite them.
  const groupsClaim = env.OIDC_GROUPS_CLAIM || "groups";
  for (const name of splitClaimNames(values.ROW_FILTER_CLAIMS ?? "")) {
    if (!CLAIM_NAME.test(name)) {
      error(
        "ROW_FILTER_CLAIMS",
        `"${name.slice(0, 64)}" is not a claim name: use letters, digits and _ . : / -, starting with a letter or _.`,
      );
    } else if (name === "sub") {
      error(
        "ROW_FILTER_CLAIMS",
        'lists "sub", which a row filter can always use; remove it.',
      );
    } else if (RESERVED_CLAIMS.has(name) || name === groupsClaim) {
      error(
        "ROW_FILTER_CLAIMS",
        `lists "${name}", which the session token uses for itself. Map the value to another claim name in the realm.`,
      );
    }
  }

  // --- Allowed origins (#25) ----------------------------------------------
  // Matched exactly against a request's `Origin`, which never has a path or a
  // trailing slash, so an entry with either would silently match nothing.
  for (const origin of splitOrigins(values.ALLOWED_ORIGINS ?? "")) {
    if (!isOrigin(origin)) {
      error(
        "ALLOWED_ORIGINS",
        `"${origin.slice(0, 80)}" is not an origin: give scheme, host and port only, e.g. https://grafana.example.com`,
      );
    }
  }

  // --- OIDC ---------------------------------------------------------------
  // Keycloak is the only way to sign in outside demo mode, so in production
  // the confidential client must be configured completely.
  // OIDC_REDIRECT_URI is optional: it is derived from the request origin when
  // unset. Demo mode has no realm, and the block above refuses one.
  const oidcRequired: Array<[keyof Env, string]> = demo
    ? []
    : [
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

  // --- MCP clients (#149) --------------------------------------------------
  // The MCP client is a second, public realm client, and `/api/mcp` tells a
  // token minted for it from one minted for the browser's confidential client
  // by `aud` and `azp`. The same id for both would make every browser sign-in's
  // access token a valid MCP credential, and the public client's tokens valid
  // wherever the confidential client's are checked by audience.
  if (!demo && values.OIDC_MCP_CLIENT_ID) {
    if (values.OIDC_MCP_CLIENT_ID === values.OIDC_CLIENT_ID) {
      error(
        "OIDC_MCP_CLIENT_ID",
        `is "${values.OIDC_MCP_CLIENT_ID}", the same as OIDC_CLIENT_ID. Register a separate public client for MCP clients (docs/operations/keycloak, "MCP clients").`,
      );
    }
    if (!production && !(values.OIDC_ISSUER && values.OIDC_JWKS_URL)) {
      warning(
        "OIDC_MCP_CLIENT_ID",
        "is set but OIDC_ISSUER or OIDC_JWKS_URL is not; /api/mcp cannot verify a realm token until both are.",
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
