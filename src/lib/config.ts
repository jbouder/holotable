import {
  DEFAULT_PALETTE,
  isPalette,
  PALETTE_INFO,
  PALETTE_NAME,
  type Palette,
  PALETTES,
} from "@/lib/theme";
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

/**
 * A DuckDB memory size, as `DUCKDB_MEMORY_LIMIT` takes one: `512MB`, `2GB`,
 * `1.5GiB`. Interpolated into a `SET` statement, so the client checks it
 * against this again before it is used.
 */
export const DUCKDB_MEMORY = /^\d+(?:\.\d+)?(?:KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/;

/**
 * The ceiling on `DUCKDB_UPLOAD_MAX_FILES` (#595): every uploaded file is a
 * table, and a source's allowlist holds at most this many (`MAX_TABLES`,
 * which `test/config.test.ts` holds it to).
 */
export const MAX_UPLOAD_FILES = 200;

/** A single-unit duration, as `PROMQL_MAX_RANGE` takes one: `7d`, `12h`. */
const DURATION = /^(\d+)(ms|s|m|h|d|w)$/;

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? fallback : raw;
}

/**
 * `AUTH_MODE` values. `oidc` is Keycloak, the default and the only real one.
 * `demo` (a public demo, #251) and `local` (one person on their own machine,
 * #600) mint a session without a login instead.
 */
export const AUTH_MODES = ["oidc", "demo", "local"] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

/** The modes that mint their own sessions: no realm, no login screen. */
export type MintingMode = Exclude<AuthMode, "oidc">;

/**
 * Whether a mode signs people in through a realm. False for `demo` and
 * `local`, which mint a session on arrival: there is no callback, no renewal,
 * no back-channel logout and no MCP client. Takes a raw string too, for the
 * checks that read the environment before `config` exists; anything that is
 * not a minting mode is `oidc`, so a typo fails closed.
 */
export function hasRealm(mode: string | undefined): boolean {
  return mode !== "demo" && mode !== "local";
}

/** What a demo visitor is granted when `DEMO_GROUPS` is unset. */
export const DEFAULT_DEMO_GROUPS = "/workspaces/demo/editor";

/** What the local owner is granted when `LOCAL_GROUPS` is unset (#600). */
export const DEFAULT_LOCAL_GROUPS = "/workspaces/local/source-admin";

/**
 * `LOCAL_MODEL_DETECT` values (#607): `auto` is on in local mode and off
 * otherwise; `on` and `off` say so outright.
 */
export const LOCAL_MODEL_DETECT_VALUES = ["auto", "on", "off"] as const;

/**
 * Where a model on the person's own machine is looked for when
 * `LOCAL_MODEL_ENDPOINTS` is unset (#607): Ollama (11434) and LM Studio (1234),
 * from inside a container and from outside one.
 */
export const DEFAULT_LOCAL_MODEL_ENDPOINTS =
  "http://host.docker.internal:11434/v1, http://localhost:11434/v1, http://host.docker.internal:1234/v1, http://localhost:1234/v1";

/** The most endpoints `LOCAL_MODEL_ENDPOINTS` may list: each is probed at every scan. */
export const MAX_LOCAL_MODEL_ENDPOINTS = 16;

/**
 * Does detection of a model on this machine run (#607)? `LOCAL_MODEL_DETECT`
 * resolved against `AUTH_MODE`. A value that is not one of the three is off
 * here, so a typo fails closed (and `validateConfig` refuses to boot on it).
 */
export function localModelDetection(env: Environment): boolean {
  const raw = env.LOCAL_MODEL_DETECT || "auto";
  if (raw === "on") return true;
  if (raw === "auto") return env.AUTH_MODE === "local";
  return false;
}

/**
 * `LOCAL_MODEL_ENDPOINTS` (or its default) as base URLs. An entry that is not
 * an `http`/`https` URL with a host and no credentials is dropped and reported
 * by its position in the list (1-based), never by its text: a mistyped entry
 * may carry a password.
 */
export function parseLocalModelEndpoints(raw: string | undefined): {
  endpoints: string[];
  invalid: number[];
} {
  const entries = (raw || DEFAULT_LOCAL_MODEL_ENDPOINTS).split(/[,\s]+/).filter(Boolean);
  const endpoints: string[] = [];
  const invalid: number[] = [];
  entries.forEach((entry, index) => {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      invalid.push(index + 1);
      return;
    }
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      invalid.push(index + 1);
      return;
    }
    const href = url.href.replace(/\/+$/, "");
    if (!endpoints.includes(href)) endpoints.push(href);
  });
  return { endpoints, invalid };
}

/** `DEMO_GROUPS` / `LOCAL_GROUPS` as group paths: comma- or whitespace-separated. */
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
    oidcNext: host("holotable_oidc_next"),
    signedOut: host("holotable_signed_out"),
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
  /**
   * The longest range or offset a LogQL expression may ask for (#561). Unset,
   * it is `PROMQL_MAX_RANGE`: one bound on how far back a panel may read.
   */
  logqlMaxRange: str("LOGQL_MAX_RANGE", str("PROMQL_MAX_RANGE", "7d")),
  /** Max points retained per series in the browser rolling window. */
  maxWindowPoints: num("MAX_WINDOW_POINTS", 1_000),
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
   * How many cycles in a row a dashboard stream may stay behind before it is
   * closed with a `drop` frame (#489): a viewer, or a proxy in front of one,
   * that has stopped reading would otherwise make the server buffer its
   * frames without limit. The browser reconnects after a spread delay and
   * resumes from its last event id. Default 3.
   */
  sseSlowTicks: num("SSE_SLOW_TICKS", 3),

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
   * (#22). Keep it below the model-backed routes' 120s `maxDuration`, or
   * the platform cuts the response first, with no error. Documented default:
   * 90s, which a whole dashboard from a slower model needs.
   */
  aiRequestTimeoutMs: num("AI_REQUEST_TIMEOUT_MS", 90_000),

  /**
   * Most model calls in flight on this server, across every workspace and
   * model (#496). Past it a call is refused with 429 and a short
   * `Retry-After`, the same way the per-user rate limit is, rather than every
   * call reaching the provider at once and failing on its rate limit. `0`
   * turns the cap off. Documented default: 16.
   */
  llmMaxInFlight: num("LLM_MAX_IN_FLIGHT", 16),
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
   * Whether the server looks for a model on the person's own machine (#607):
   * `auto` (on when AUTH_MODE=local, off otherwise), `on` or `off`. When on,
   * every host in LOCAL_MODEL_ENDPOINTS is reachable by the probe and by the
   * models it finds as if it were in AI_BASE_URL_ALLOWLIST; a base URL typed in
   * the app is still held to AI_BASE_URL_ALLOWLIST alone.
   */
  localModelDetect: str("LOCAL_MODEL_DETECT", "auto"),
  /**
   * The OpenAI-style base URLs probed for a model on this machine (#607),
   * comma- or whitespace-separated. The default is Ollama's and LM Studio's,
   * from inside a container and outside: `http://host.docker.internal:11434/v1`,
   * `http://localhost:11434/v1`, `http://host.docker.internal:1234/v1`,
   * `http://localhost:1234/v1`. Ignored unless LOCAL_MODEL_DETECT resolves to on.
   */
  localModelEndpoints: str("LOCAL_MODEL_ENDPOINTS", DEFAULT_LOCAL_MODEL_ENDPOINTS),

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
  /**
   * How far back discovery, refresh and the connection test look for a
   * metric's series and labels (#386). A duration such as `1h` or `6h`.
   */
  prometheusDiscoveryWindow: str("PROMETHEUS_DISCOVERY_WINDOW", "1h"),
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
   * The most log lines one Loki query asks for and keeps (#562): the
   * `limit` the server sends on every log query, newest first, inside
   * `MAX_QUERY_ROWS` and a logs panel's own limit. A cut is said on the panel.
   */
  lokiMaxEntries: num("LOKI_MAX_ENTRIES", 1_000),
  /**
   * The most series one Loki metric query's result may hold before it is
   * refused as the author's to narrow (#562), as `PROMETHEUS_MAX_SERIES` is.
   */
  lokiMaxSeries: num("LOKI_MAX_SERIES", 100),

  /**
   * The directory DuckDB sources (#572) may read: an absolute path, under
   * which each source names a directory of Parquet, CSV and JSON files or a
   * `.duckdb` file. A path that resolves outside it, symlinks included, is
   * refused. Empty (the default) refuses every DuckDB source, so the kind is
   * closed until an operator chooses what it may read.
   */
  duckdbSourcesDir: str("DUCKDB_SOURCES_DIR", ""),
  /**
   * The most memory one DuckDB source's engine may use, in DuckDB's own
   * units (`512MB`, `2GB`). Each source has its own engine, so the server's
   * worst case is this times the DuckDB sources in use. A query that needs
   * more fails with DuckDB's out-of-memory error, not the process's.
   */
  duckdbMemoryLimit: str("DUCKDB_MEMORY_LIMIT", "512MB"),
  /** The threads one DuckDB source's engine may run a query on. */
  duckdbThreads: num("DUCKDB_THREADS", 2),
  /**
   * The largest file, in bytes, a source admin may upload from the browser as
   * a DuckDB source (#595). Streamed to disk under `DUCKDB_SOURCES_DIR/uploads`
   * and refused, with nothing left behind, past this.
   */
  duckdbUploadMaxBytes: num("DUCKDB_UPLOAD_MAX_BYTES", 50 * 1024 * 1024),
  /** The most files one upload, and so one uploaded DuckDB source, may hold. */
  duckdbUploadMaxFiles: num("DUCKDB_UPLOAD_MAX_FILES", 20),

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
   * How many Chat conversations (#416) one person keeps. Past it, the one
   * least recently used goes when a new one is started; the two limits above
   * apply within each. Documented default: 200 conversations.
   */
  chatConversationsMax: num("CHAT_CONVERSATIONS_MAX", 200),

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
   * How often the retention sweep runs (#494), in milliseconds. The
   * generation log, conversations and their messages are also swept when
   * they are written, but a quiet workspace writes nothing, so this sweeps
   * them on a timer too, in bounded batches. Jittered by up to a tenth, so
   * instances started together do not sweep together. `0` turns the timer
   * off. Documented default: 1 hour.
   */
  retentionSweepIntervalMs: num("RETENTION_SWEEP_INTERVAL_MS", 3_600_000),

  /**
   * How many versions of one dashboard are kept (#494). A save past the cap
   * removes the oldest, never the current one. `0` keeps every version.
   * Documented default: 100.
   */
  dashboardVersionsKeep: num("DASHBOARD_VERSIONS_KEEP", 100),

  /**
   * Most dashboard pollers one process runs (#495). A stream that would need
   * one more is refused and retried shortly; viewers of a running poller are
   * unaffected. `0` derives it from the heap: half the V8 heap limit (which
   * the Helm chart sets from the memory limit) over about 11 MB a poller.
   */
  maxPollers: num("MAX_POLLERS", 0),

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
   * for the public demo only: `/api/auth/login` mints a session for every
   * visitor with no login screen, holding {@link demoGroups}. `local` (#600)
   * is one person on their own machine: the same route mints the one owner's
   * session, holding {@link localGroups}. Anything but the exact string
   * `demo` or `local` is `oidc`, so a typo fails closed (and `validateConfig`
   * refuses to boot on it). Server-only in practice: the browser bundle has
   * no `AUTH_MODE` and always reads `oidc`, so a client component is handed
   * the mode as a prop instead of reading it here.
   */
  authMode: (process.env.AUTH_MODE === "demo" || process.env.AUTH_MODE === "local"
    ? process.env.AUTH_MODE
    : "oidc") as AuthMode,
  /**
   * The named theme a browser shows before its person picks one (#503): a
   * built-in theme, or the one `THEME_FILE` loads (#508). A name the app does
   * not offer is refused at boot, and reads as `holotable` here. Read when
   * used, after the operator's theme has registered. Server-only: the root
   * layout renders it onto `<html>` and into the first-paint script.
   */
  get themeDefaultPalette(): Palette {
    return isPalette(process.env.THEME_DEFAULT_PALETTE)
      ? process.env.THEME_DEFAULT_PALETTE
      : DEFAULT_PALETTE;
  },
  /**
   * The groups every demo visitor's session carries, in the same
   * `/workspaces/{id}/{role}` form as a Keycloak `groups` claim, parsed by the
   * same parser. Never source-admin, never platform admin: `validateConfig`
   * refuses both. Ignored unless {@link authMode} is `demo`.
   */
  demoGroups: splitGroups(str("DEMO_GROUPS", DEFAULT_DEMO_GROUPS)),
  /**
   * The groups the local owner's session carries (#600), parsed like
   * {@link demoGroups}. Source-admin is allowed, which is the point of the
   * mode; platform admin is not, and a workspace role is required:
   * `validateConfig` refuses both. Ignored unless {@link authMode} is `local`.
   */
  localGroups: splitGroups(str("LOCAL_GROUPS", DEFAULT_LOCAL_GROUPS)),

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
  /** Where a sign-in returns to once the realm sends the browser back. */
  oidcNextCookieName: COOKIES.oidcNext,
  /**
   * Set by sign-out: while present, a page request with no session shows the
   * sign-in card instead of going straight to the realm, whose own session
   * would otherwise sign the person straight back in.
   */
  signedOutCookieName: COOKIES.signedOut,
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
 * The `maxDuration` of every route that may call a model (generation, both
 * chats, MCP, the model tests), in milliseconds. `test/config.test.ts` holds
 * it to the routes.
 */
export const AI_ROUTE_MAX_DURATION_MS = 120_000;

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
  AI_MODELS_FILE: blank(z.string()),
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
  LOCAL_MODEL_DETECT: blank(
    z.enum(LOCAL_MODEL_DETECT_VALUES, {
      error: 'must be "auto" (on in local mode, off otherwise), "on" or "off"',
    }),
  ),
  LOCAL_MODEL_ENDPOINTS: blank(
    z.string().superRefine((v, ctx) => {
      const { endpoints, invalid } = parseLocalModelEndpoints(v);
      if (invalid.length > 0) {
        ctx.addIssue({
          code: "custom",
          message: `${invalid.length > 1 ? "entries" : "entry"} ${invalid.join(", ")} ${invalid.length > 1 ? "are" : "is"} not an http(s) base URL with a host and no user name or password, e.g. http://localhost:11434/v1`,
        });
      } else if (endpoints.length > MAX_LOCAL_MODEL_ENDPOINTS) {
        ctx.addIssue({
          code: "custom",
          message: `lists ${endpoints.length} endpoints; at most ${MAX_LOCAL_MODEL_ENDPOINTS} may be probed`,
        });
      }
    }),
  ),
  SOURCE_URL_ALLOWLIST: blank(
    z.string().refine((v) => invalidAllowlistEntries(v).length === 0, {
      error:
        "must be a comma-separated list of host names, addresses and CIDR ranges, e.g. prometheus.monitoring.svc,10.0.0.0/8",
    }),
  ),
  PROMETHEUS_DISCOVERY_WINDOW: blank(
    z
      .string()
      .regex(DURATION, "must be a duration such as 1h or 6h")
      .refine(
        (v) => !DURATION.test(v) || Number(DURATION.exec(v)?.[1]) > 0,
        "must be longer than zero",
      ),
  ),
  PROMETHEUS_MIN_STEP_MS: blank(positiveInt),
  PROMQL_MAX_POINTS: blank(positiveInt),
  PROMETHEUS_MAX_SERIES: blank(positiveInt),
  LOKI_MAX_ENTRIES: blank(positiveInt),
  LOKI_MAX_SERIES: blank(positiveInt),
  DUCKDB_SOURCES_DIR: blank(
    z
      .string()
      .startsWith("/", "must be an absolute path: the directory DuckDB sources may read"),
  ),
  DUCKDB_MEMORY_LIMIT: blank(
    z.string().regex(DUCKDB_MEMORY, "must be a size such as 512MB or 2GB"),
  ),
  DUCKDB_THREADS: blank(positiveInt),
  // Shape-checked in validateConfig rather than here, so a bad value warns in
  // development (the default is used) and is fatal only in production.
  DUCKDB_UPLOAD_MAX_BYTES: blank(z.string()),
  DUCKDB_UPLOAD_MAX_FILES: blank(z.string()),
  LLM_RATE_PER_MINUTE: blank(nonNegativeInt),
  LLM_DAILY_TOKEN_BUDGET: blank(nonNegativeInt),

  AUTH_MODE: blank(
    z.enum(AUTH_MODES, {
      error:
        'must be "oidc" (Keycloak, the default), "demo" (a public demo) or "local" (one person on their own machine)',
    }),
  ),
  DEMO_GROUPS: blank(z.string()),
  LOCAL_GROUPS: blank(z.string()),
  THEME_DEFAULT_PALETTE: blank(
    z
      .string()
      .regex(PALETTE_NAME, "must be a theme's name: lowercase letters, digits, dashes"),
  ),
  THEME_FILE: blank(z.string().startsWith("/", "must be an absolute path")),
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
  LOGQL_MAX_RANGE: blank(
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
  CHAT_CONVERSATIONS_MAX: blank(positiveInt),
  GENERATION_LOG_RETENTION_DAYS: blank(nonNegativeInt),
  RETENTION_SWEEP_INTERVAL_MS: blank(nonNegativeInt),
  DASHBOARD_VERSIONS_KEEP: blank(nonNegativeInt),
  MAX_POLLERS: blank(nonNegativeInt),
  LLM_MAX_IN_FLIGHT: blank(nonNegativeInt),
  SHUTDOWN_GRACE_MS: blank(positiveInt),
  SSE_REAUTH_INTERVAL_MS: blank(positiveInt),
  SSE_SLOW_TICKS: blank(positiveInt),
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
  const local = values.AUTH_MODE === "local";
  // Either mode that mints its own sessions (#600): no realm to configure.
  const minting = demo || local;

  // --- Themes -------------------------------------------------------------
  // A default that is not built in must be the operator's own, which only
  // `THEME_FILE` can supply; src/lib/startup.ts checks it names that file.
  if (
    values.THEME_DEFAULT_PALETTE &&
    !(PALETTES as readonly string[]).includes(values.THEME_DEFAULT_PALETTE) &&
    !values.THEME_FILE
  ) {
    error(
      "THEME_DEFAULT_PALETTE",
      `must be a theme the app ships (${PALETTE_INFO.map((p) => p.name).join(", ")}), or the name in THEME_FILE.`,
    );
  }

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
  // quick-start image sets this on purpose and runs in local mode (the hosted
  // demo in demo mode), where there is no login to steal; a real deployment
  // should hear about it.
  if (production && values.SESSION_COOKIE_SECURE === "false" && !minting) {
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

  // --- DuckDB sources (#572) ---------------------------------------------
  // Closed by default, like `/api/metrics`: an unset directory is not a
  // problem, it refuses every DuckDB source with a message naming it. What
  // is worth saying is a bound set for an engine that can never open.
  // The upload bounds (#595): a malformed one falls back to its default, so
  // it is fatal only where a typo should stop a deploy.
  const uploadBound = (
    variable: "DUCKDB_UPLOAD_MAX_BYTES" | "DUCKDB_UPLOAD_MAX_FILES",
    max: number,
    what: string,
  ) => {
    const raw = values[variable];
    if (raw === undefined) return;
    const n = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(n) || n < 1 || n > max) {
      missing(variable, `must be a whole number from 1 to ${max} (${what}).`);
    }
  };
  uploadBound(
    "DUCKDB_UPLOAD_MAX_BYTES",
    Number.MAX_SAFE_INTEGER,
    "the largest uploaded file, in bytes",
  );
  uploadBound(
    "DUCKDB_UPLOAD_MAX_FILES",
    MAX_UPLOAD_FILES,
    "the most files one upload may hold; each is a table",
  );
  if (!values.DUCKDB_SOURCES_DIR) {
    for (const variable of [
      "DUCKDB_MEMORY_LIMIT",
      "DUCKDB_THREADS",
      "DUCKDB_UPLOAD_MAX_BYTES",
      "DUCKDB_UPLOAD_MAX_FILES",
    ] as const) {
      if (env[variable]) {
        warning(
          variable,
          "is set but ignored: DUCKDB_SOURCES_DIR is not set, so no DuckDB source can be opened.",
        );
      }
    }
  }

  // --- AI provider --------------------------------------------------------
  // In demo and local mode the model is optional: the seeded dashboards, the
  // viewer and the SQL editor need no key, and the generate and chat pages say
  // what is missing instead of failing a request (src/lib/ai/configured.ts).
  const aiMissing = minting ? warning : missing;
  const provider = values.AI_PROVIDER ?? "openai-compatible";
  // With AI_MODELS_FILE (#440) the server's models come from the file, which
  // `src/lib/startup.ts` reads and checks; the legacy variables are then
  // optional, and checked only when they name a model.
  const legacy = !values.AI_MODELS_FILE || Boolean(values.AI_PROVIDER || values.AI_MODEL);
  // The recorded model (#88, src/lib/ai/stub.ts) answers every prompt with the
  // same spec. It is for the end-to-end suite, which runs a production build;
  // anywhere else in production it would be a deployment that forgot to
  // configure a model and boots green anyway, so it has to be asked for twice.
  if (!legacy) {
    // Nothing to check: the file lists the server's models.
  } else if (provider === "stub") {
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
  if (legacy && provider === "openai-compatible" && !values.OPENAI_API_KEY) {
    aiMissing(
      "OPENAI_API_KEY",
      "is not set but AI_PROVIDER is openai-compatible; the provider will reject every request. Set the API key for OPENAI_BASE_URL.",
    );
  }
  if (legacy && provider === "gateway" && !values.AI_GATEWAY_API_KEY) {
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
      `is ${values.AI_REQUEST_TIMEOUT_MS}; the generate and chat routes end at ${AI_ROUTE_MAX_DURATION_MS}ms, so a hung model would be cut off without an error. Set it below that, e.g. 90000.`,
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

  // --- Local mode ---------------------------------------------------------
  // One person on their own machine (#600): every request without a session
  // is signed in as the one owner, holding LOCAL_GROUPS. Source-admin is the
  // point (adding a source, uploading files), so it is allowed here where demo
  // mode refuses it; what keeps the mode fenced is that it never shares a
  // deployment with a realm, never reaches platform admin, and the banner and
  // the docs say that everyone who can reach the server is its owner.
  if (local) {
    for (const variable of oidcVariables) {
      if (env[variable]) {
        error(
          variable,
          "is set while AUTH_MODE is local. Local mode signs in everyone who can reach the server as its owner, without a login, and must never run beside a real identity provider; unset it, or set AUTH_MODE=oidc.",
        );
      }
    }
    const groups = splitGroups(values.LOCAL_GROUPS ?? DEFAULT_LOCAL_GROUPS);
    const identity = parseGroups("local", groups);
    if (identity.platformAdmin || groups.includes(PLATFORM_ADMIN_GROUP)) {
      error(
        "LOCAL_GROUPS",
        `contains ${PLATFORM_ADMIN_GROUP}; the local owner is never a platform admin. Grant /workspaces/<id>/source-admin, editor or viewer.`,
      );
    } else if (Object.keys(identity.workspaces).length === 0) {
      error(
        "LOCAL_GROUPS",
        "grants no workspace role, so the local owner would see an empty app. Use paths like /workspaces/local/source-admin.",
      );
    }
  } else if (env.LOCAL_GROUPS) {
    warning("LOCAL_GROUPS", "is set but ignored unless AUTH_MODE=local.");
  }

  // --- A model on this machine (#607) -------------------------------------
  // Detection probes the listed endpoints and reaches them over plain http, so
  // a list that is set but never used is worth a word: it is not allowlisting
  // anything.
  if (env.LOCAL_MODEL_ENDPOINTS && !localModelDetection(env)) {
    warning(
      "LOCAL_MODEL_ENDPOINTS",
      "is set but ignored: LOCAL_MODEL_DETECT resolves to off (auto is on only when AUTH_MODE=local).",
    );
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
  // Keycloak is the only way to sign in outside demo and local mode, so in
  // production the confidential client must be configured completely.
  // OIDC_REDIRECT_URI is optional: it is derived from the request origin when
  // unset. Demo and local mode have no realm, and the blocks above refuse one.
  const oidcRequired: Array<[keyof Env, string]> = minting
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
      error(variable, `is not set: ${why}. See docs/admin/keycloak.`);
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
  if (!minting && values.OIDC_MCP_CLIENT_ID) {
    if (values.OIDC_MCP_CLIENT_ID === values.OIDC_CLIENT_ID) {
      error(
        "OIDC_MCP_CLIENT_ID",
        `is "${values.OIDC_MCP_CLIENT_ID}", the same as OIDC_CLIENT_ID. Register a separate public client for MCP clients (docs/admin/keycloak, "MCP clients").`,
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
