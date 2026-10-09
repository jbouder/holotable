import { join } from "node:path";

/**
 * Where the end-to-end stack listens, and the environment the app and the
 * seeder run with (#88). One module so the Playwright config, the global setup
 * and the specs cannot disagree about a port.
 *
 * Every port is off the defaults on purpose — a contributor's `npm run dev`,
 * dev database and dev Keycloak keep 3000, 5432 and 8080 — and each can be
 * moved with the variable named beside it. The app port is the one the dev
 * realm (keycloak/holotable-realm.json) lists as a redirect URI.
 */

export const APP_PORT = Number(process.env.E2E_PORT || 3107);
export const PG_PORT = Number(process.env.E2E_PG_PORT || 55433);
export const KC_PORT = Number(process.env.E2E_KC_PORT || 18181);
/** The stack's Prometheus (#390), which scrapes the app on the host. */
export const PROM_PORT = Number(process.env.E2E_PROM_PORT || 19190);
/** The bearer the stack's Prometheus scrapes `/api/metrics` with. Not a secret. */
export const SCRAPE_TOKEN = "e2e-scrape-token-0123456789";
/** Where the app and the seeder reach that Prometheus. */
export const PROM_URL = `http://localhost:${PROM_PORT}`;

export const BASE_URL = `http://localhost:${APP_PORT}`;
export const ISSUER = `http://localhost:${KC_PORT}/realms/holotable`;
export const DATABASE_URL = `postgresql://holotable:holotable@localhost:${PG_PORT}/holotable`;

/** The realm's users (keycloak/holotable-realm.json). */
export const USERS = {
  /** `/workspaces/demo/source-admin` and `/platform-admins`. */
  admin: { username: "demo", password: "demo" },
  /** `/workspaces/demo/viewer` only. */
  viewer: { username: "viewer", password: "viewer" },
} as const;

export type Role = keyof typeof USERS;

/** The repository root, which every spawned command runs from. */
export const ROOT = join(__dirname, "..");

/** Where the setup project leaves each role's signed-in session. */
export const storageStatePath = (role: Role) => join(__dirname, ".auth", `${role}.json`);

/**
 * The app's environment. Spelled out in full rather than inherited, because
 * `next start` also reads a contributor's `.env` for anything left unset, and
 * a suite that passes only on one laptop is not a test. Production mode, which
 * is what `next start` runs, so the boot-time validation is the real one.
 */
export const APP_ENV: Record<string, string> = {
  NODE_ENV: "production",
  NEXT_MANUAL_SIG_HANDLE: "true",
  NEXT_TELEMETRY_DISABLED: "1",
  PORT: String(APP_PORT),
  DATABASE_URL,
  // Not a secret: it signs sessions on a database that lives in tmpfs.
  SESSION_SECRET: "e2e-session-secret-0123456789abcdefghijklmnop",
  SOURCE_SECRET_REFS: "TS_METRICS:demo",
  TS_METRICS_USERNAME: "metrics_ro",
  TS_METRICS_PASSWORD: "readonly",
  // The recorded model (src/lib/ai/stub.ts): deterministic, offline, free.
  AI_PROVIDER: "stub",
  AI_STUB_IN_PRODUCTION: "true",
  AI_MODEL: "",
  OPENAI_API_KEY: "",
  AI_GATEWAY_API_KEY: "",
  LLM_RATE_PER_MINUTE: "0",
  LLM_DAILY_TOKEN_BUDGET: "0",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: "holotable",
  OIDC_CLIENT_SECRET: "holotable-dev-secret",
  OIDC_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
  OIDC_REDIRECT_URI: `${BASE_URL}/api/auth/callback`,
  OIDC_SCOPE: "openid profile email",
  OIDC_GROUPS_CLAIM: "groups",
  AUTH_MODE: "",
  // Plain HTTP on localhost.
  SESSION_COOKIE_SECURE: "false",
  // Fast enough that a live panel visibly moves while a test watches it.
  DEFAULT_REFRESH_INTERVAL_MS: "2000",
  MIN_REFRESH_INTERVAL_MS: "1000",
  LOG_LEVEL: "warn",
  // The stack's Prometheus scrapes the app (#390), so the gate is open to it.
  METRICS_TOKEN: SCRAPE_TOKEN,
  METRICS_ALLOWED_CIDRS: "",
  // And a Prometheus source may reach it: loopback, so it has to be named.
  SOURCE_URL_ALLOWLIST: "localhost",
};

/** The looping seeder (scripts/seed.ts): demo sources, dashboards and rows. */
export const SEED_ENV: Record<string, string> = {
  DATABASE_URL,
  TIMESCALEDB_URL: DATABASE_URL,
  TS_METRICS_HOST: "localhost",
  TS_METRICS_PORT: String(PG_PORT),
  POSTGRES_DB: "holotable",
  SEED_DEMO: "true",
  SEED_INTERVAL_MS: "1000",
  SEED_BACKFILL: "30m",
  // The seeded `prometheus-self` source (#390) asks the stack's Prometheus.
  PROMETHEUS_SELF_URL: PROM_URL,
};
