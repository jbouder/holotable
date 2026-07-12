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
  return raw === "1" || raw.toLowerCase() === "true";
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
  defaultTimeTo: str("DEFAULT_TIME_TO", "now"),

  /** Hard cap on rows returned by any query executed against the metrics store. */
  maxQueryRows: num("MAX_QUERY_ROWS", 5_000),
  /** Max points retained per series in the browser rolling window. */
  maxWindowPoints: num("MAX_WINDOW_POINTS", 720),
  /** Statement timeout (seconds) applied to every metrics query. */
  queryTimeoutSeconds: num("QUERY_TIMEOUT_SECONDS", 20),

  /**
   * The AI model id used for generation, surfaced read-only to the UI so users
   * can see which model produced their specs. Empty when unconfigured. This is
   * a display label only — actual provider/model resolution lives in
   * src/lib/ai/provider.ts.
   */
  aiModel: str("AI_MODEL", ""),

  /** Cookie name used for the session JWT. */
  sessionCookieName: str("SESSION_COOKIE_NAME", "holotable_session"),

  /** Whether dev-only local login is enabled. Must be false in production. */
  devAuthEnabled: bool("DEV_AUTH_ENABLED", process.env.NODE_ENV !== "production"),

  isProduction: process.env.NODE_ENV === "production",
} as const;

export type AppConfig = typeof config;
