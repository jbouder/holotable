import { createHash } from "node:crypto";
import { Pool, type PoolConfig } from "pg";
import { config } from "@/lib/config";
import { log } from "@/lib/log";
import type { SourceRecord } from "@/lib/registry";
import { resolveCredentials } from "@/lib/secrets/credentials";

/**
 * One bounded `pg.Pool` per metrics source (#13).
 *
 * Every execution used to open its own `Client`, so a dashboard of twelve
 * panels on a fifteen-second refresh made twelve connections every fifteen
 * seconds, and nothing capped how many were open at once against one source.
 * A pool reuses them, and its `max` (`MAX_POOL_PER_SOURCE`) is the most
 * connections this process will ever hold to a source. A checkout beyond it
 * waits, and the wait is bounded by the same `connectionTimeoutMillis` a fresh
 * connection would have had.
 *
 * What does not change:
 *
 * - **Credentials are re-authorized on every checkout.** {@link sourcePool}
 *   calls `resolveCredentials` each time, so a `secret_ref` whose grant is
 *   withdrawn stops working on the next query, pool or no pool.
 * - **A pool never outlives its connection settings.** The pool is keyed by a
 *   digest of everything that goes into a connection (host, port, database,
 *   TLS, user, password). Editing the source or rotating its credentials gives
 *   a different digest and therefore a new pool; the old one is ended, which
 *   lets its checked-out clients finish and closes them as they come back.
 * - **Session state does not leak between executions.** That is the caller's
 *   half of the contract, kept in `runPlan`: every statement runs inside
 *   `BEGIN TRANSACTION READ ONLY` with a `SET LOCAL search_path`, the
 *   transaction is always rolled back before the client is released, and a
 *   client whose rollback fails is destroyed rather than returned. The guard
 *   refuses `set_config` and the advisory-lock functions, the two ways a
 *   `SELECT` could leave anything behind that a rollback would not undo.
 *
 * Cached on `globalThis` for the reason `metrics.ts` gives: Next may bundle the
 * stream route, the query route and the poller into separate chunks, and two
 * copies of this map would mean two pools per source and twice the cap.
 */

interface Entry {
  fingerprint: string;
  pool: Pool;
}

/** Builds a pool. Swapped out by tests; production uses `pg`'s own. */
export type PoolFactory = (options: PoolConfig) => Pool;

interface State {
  pools: Map<string, Entry>;
  factory: PoolFactory;
}

const CACHE_KEY = Symbol.for("holotable.sourcePools");
type Cache = { [CACHE_KEY]?: State };

function state(): State {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= {
    pools: new Map(),
    factory: (options) => new Pool(options),
  };
  return cache[CACHE_KEY];
}

/** How long an unused connection stays open before the pool closes it. */
export const POOL_IDLE_TIMEOUT_MS = 30_000;

/** The options a source's pool is built with: connection settings and limits. */
export function poolOptions(source: SourceRecord): PoolConfig {
  // Re-authorized on every checkout: the ref must still be granted to the
  // workspace this source belongs to, whatever it was granted when saved.
  const credentials = resolveCredentials(source.secretRef, source.workspaceId);
  return {
    host: source.config.host,
    port: source.config.port,
    database: source.config.database,
    user: credentials.username,
    password: credentials.password,
    ssl: source.config.ssl,
    max: config.maxPoolPerSource,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: (config.queryTimeoutSeconds + 5) * 1000,
    statement_timeout: config.queryTimeoutSeconds * 1000,
    application_name: "holotable",
  };
}

/**
 * A digest of every option that decides where a connection goes and who it
 * is. The password is in it so that a rotation is a new pool, and hashed so
 * the key held in memory is not a second copy of it.
 */
export function connectionFingerprint(options: PoolConfig): string {
  const { host, port, database, user, password, ssl } = options;
  return createHash("sha256")
    .update(JSON.stringify([host, port, database, user, password, ssl ?? null]))
    .digest("hex");
}

function endPool(sourceId: string, pool: Pool): Promise<void> {
  return pool.end().catch((err: unknown) => {
    log.warn("source_pool.end_failed", { sourceId, err });
  });
}

/**
 * The pool for `source`, created on first use and replaced when its
 * connection settings change.
 */
export function sourcePool(source: SourceRecord): Pool {
  const { pools, factory } = state();
  const options = poolOptions(source);
  const fingerprint = connectionFingerprint(options);

  const current = pools.get(source.id);
  if (current?.fingerprint === fingerprint) return current.pool;

  if (current) void endPool(source.id, current.pool);
  const pool = factory(options);
  // An idle client whose server goes away emits `error` on the pool, and an
  // unhandled `error` event ends the process. The pool has already dropped
  // that client; the next checkout opens a fresh one.
  pool.on("error", (err) => {
    log.warn("source_pool.idle_client_error", { sourceId: source.id, err });
  });
  pools.set(source.id, { fingerprint, pool });
  return pool;
}

/** Close a deleted source's pool now rather than at its idle timeout. */
export async function dropSourcePool(sourceId: string): Promise<void> {
  const { pools } = state();
  const entry = pools.get(sourceId);
  if (!entry) return;
  pools.delete(sourceId);
  await endPool(sourceId, entry.pool);
}

/**
 * Close every source pool. Graceful shutdown (#47) only, after in-flight
 * executions have finished.
 */
export async function closeSourcePools(): Promise<void> {
  const { pools } = state();
  const entries = [...pools];
  pools.clear();
  await Promise.all(entries.map(([id, entry]) => endPool(id, entry.pool)));
}

/** How many source pools are open. For tests. */
export function sourcePoolCount(): number {
  return state().pools.size;
}

/**
 * Replace how pools are built. For tests: returns the previous factory so it
 * can be put back, and clears the cache so no real pool is reused.
 */
export function setPoolFactoryForTests(factory: PoolFactory): PoolFactory {
  const s = state();
  const previous = s.factory;
  s.factory = factory;
  s.pools.clear();
  return previous;
}
