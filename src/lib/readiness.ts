import type { Environment } from "@/lib/config";
import { isDraining } from "@/lib/shutdown";

/**
 * Readiness checks behind `/api/ready`.
 *
 * Readiness answers one question: should this instance be sent traffic? It is
 * probed continuously by an orchestrator, so every check here is cheap, has a
 * deadline, and never costs money — the AI check reads configuration and never
 * calls a provider.
 *
 * Required vs advisory. Only the config store is required: without it no page
 * and no dashboard can be served, so an instance that cannot reach it should
 * be taken out of rotation. Keycloak is advisory on purpose — sessions are
 * first-party tokens (`src/lib/auth/session.ts`), so a realm outage stops new
 * logins but leaves signed-in users working, and failing readiness across
 * every instance would turn a login outage into a total one. AI configuration
 * is advisory for the same reason: only generation fails. Both are still
 * reported, as `degraded`, so a probe body says what is wrong.
 *
 * Nothing here puts a connection string, a URL, a hostname, or a credential in
 * its result: a failure is named by the dependency plus an error *code*
 * (`ECONNREFUSED`, `28P01`, `http_503`), which is the part an operator needs
 * and the part that carries no configuration.
 */

/** The config store must answer within this, or the instance is not ready. */
const DATABASE_TIMEOUT_MS = 2_000;
/** The realm is advisory, so the probe waits for it briefly and moves on. */
const JWKS_TIMEOUT_MS = 3_000;
/**
 * How long a JWKS answer is reused. A probe runs every few seconds and the
 * realm's keys change rarely, so a reachable realm is asked about once a
 * minute at most; an unreachable one is retried sooner so recovery shows up
 * quickly without hammering Keycloak while it restarts.
 */
const JWKS_OK_TTL_MS = 60_000;
const JWKS_FAIL_TTL_MS = 5_000;

export type CheckStatus = "ok" | "failed" | "skipped";

export interface DependencyCheck {
  status: CheckStatus;
  /** Why, when not `ok`: an error code or a variable name, never a value. */
  reason?: string;
  /** True when the answer was reused from cache rather than probed. */
  cached?: boolean;
}

export type ReadinessStatus = "ready" | "degraded" | "draining" | "not_ready";

export interface ReadinessReport {
  status: ReadinessStatus;
  checks: {
    database: DependencyCheck;
    identityProvider: DependencyCheck;
    aiProvider: DependencyCheck;
  };
}

export interface ReadinessDeps {
  /** Round-trip to the config store. Defaults to `SELECT 1` on the shared pool. */
  pingDatabase?: () => Promise<void>;
  /** Fetch the realm JWKS. Defaults to `fetch`. */
  fetchJwks?: (
    url: string,
    signal: AbortSignal,
  ) => Promise<{ ok: boolean; status: number }>;
  env?: Environment;
  now?: () => number;
}

/* -------------------------------------------------------------------------- */
/* Error sanitizing                                                           */
/* -------------------------------------------------------------------------- */

/** Error codes are short and alphanumeric; anything else could be a hostname. */
const SAFE_CODE = /^[A-Za-z0-9_]{1,32}$/;

/**
 * One safe word for a failure. `pg` reports a refused connection as an
 * `AggregateError` with one entry per address tried, and `fetch` reports one
 * as a bare `TypeError` with the real error in `cause`; both put the useful
 * part in `code`. The `message` may name the host and port, so it is never
 * used — the code is the whole answer, or the word `unreachable`.
 */
function failureCode(err: unknown, depth = 0): string {
  if (depth > 3) return "unreachable";
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && SAFE_CODE.test(code)) return code;
  if (err instanceof AggregateError && err.errors.length > 0) {
    return failureCode(err.errors[0], depth + 1);
  }
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause) return failureCode(cause, depth + 1);
  return "unreachable";
}

class TimeoutError extends Error {
  readonly code = "TIMEOUT";
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms);
    const done = () => clearTimeout(timer);
    promise.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e);
      },
    );
  });
}

/* -------------------------------------------------------------------------- */
/* Individual checks                                                          */
/* -------------------------------------------------------------------------- */

async function defaultPingDatabase(): Promise<void> {
  const { getPool } = await import("@/lib/db/pg");
  await getPool().query("SELECT 1");
}

async function checkDatabase(deps: ReadinessDeps): Promise<DependencyCheck> {
  const env = deps.env ?? process.env;
  if (!env.DATABASE_URL) return { status: "failed", reason: "DATABASE_URL is not set" };
  try {
    await withTimeout((deps.pingDatabase ?? defaultPingDatabase)(), DATABASE_TIMEOUT_MS);
    return { status: "ok" };
  } catch (err) {
    return { status: "failed", reason: failureCode(err) };
  }
}

/** Keyed by URL so a changed realm is re-probed rather than answered from cache. */
let jwksCache: { url: string; until: number; check: DependencyCheck } | null = null;

/** Test-only: a fresh process starts with an empty cache. */
export function resetJwksCacheForTests(): void {
  jwksCache = null;
}

async function defaultFetchJwks(
  url: string,
  signal: AbortSignal,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, { signal, cache: "no-store" });
  return { ok: res.ok, status: res.status };
}

async function checkIdentityProvider(deps: ReadinessDeps): Promise<DependencyCheck> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const url = env.OIDC_JWKS_URL;
  if (!url) return { status: "skipped", reason: "OIDC_JWKS_URL is not set" };

  const cached = jwksCache;
  if (cached && cached.url === url && cached.until > now()) {
    return { ...cached.check, cached: true };
  }

  const controller = new AbortController();
  const abort = setTimeout(() => controller.abort(), JWKS_TIMEOUT_MS);
  let check: DependencyCheck;
  try {
    const res = await (deps.fetchJwks ?? defaultFetchJwks)(url, controller.signal);
    check = res.ok
      ? { status: "ok" }
      : { status: "failed", reason: `http_${res.status}` };
  } catch (err) {
    check = { status: "failed", reason: failureCode(err) };
  } finally {
    clearTimeout(abort);
  }

  const ttl = check.status === "ok" ? JWKS_OK_TTL_MS : JWKS_FAIL_TTL_MS;
  jwksCache = { url, until: now() + ttl, check };
  return check;
}

/**
 * Configuration only. A generate request is billed, so readiness never makes
 * one; this catches the deployment that shipped without a key, which is the
 * failure worth finding before a user does.
 */
function checkAiProvider(deps: ReadinessDeps): DependencyCheck {
  const env = deps.env ?? process.env;
  if (!env.AI_MODEL) return { status: "failed", reason: "AI_MODEL is not set" };
  const provider = env.AI_PROVIDER || "openai-compatible";
  if (provider === "gateway") {
    return env.AI_GATEWAY_API_KEY
      ? { status: "ok" }
      : { status: "failed", reason: "AI_GATEWAY_API_KEY is not set" };
  }
  if (provider === "openai-compatible") {
    return env.OPENAI_API_KEY
      ? { status: "ok" }
      : { status: "failed", reason: "OPENAI_API_KEY is not set" };
  }
  return { status: "failed", reason: "AI_PROVIDER is not recognized" };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

export async function checkReadiness(deps: ReadinessDeps = {}): Promise<ReadinessReport> {
  const [database, identityProvider] = await Promise.all([
    checkDatabase(deps),
    checkIdentityProvider(deps),
  ]);
  const aiProvider = checkAiProvider(deps);
  const checks = { database, identityProvider, aiProvider };

  // Drain wins: a process on its way out reports not-ready even while every
  // dependency is still healthy, which is the whole point of the flag.
  if (isDraining()) return { status: "draining", checks };
  if (database.status === "failed") return { status: "not_ready", checks };
  const degraded = [identityProvider, aiProvider].some((c) => c.status === "failed");
  return { status: degraded ? "degraded" : "ready", checks };
}

/** `ready` and `degraded` serve traffic; `draining` and `not_ready` do not. */
export function readinessHttpStatus(status: ReadinessStatus): 200 | 503 {
  return status === "ready" || status === "degraded" ? 200 : 503;
}
