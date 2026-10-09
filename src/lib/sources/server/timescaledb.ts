import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import {
  buildCatalogPrompt,
  discoverTables,
  refreshCatalog,
  refreshDigest,
  renderCatalog,
} from "@/lib/timescaledb/catalog";
import { executePlan, sessionStatements, testSource } from "@/lib/timescaledb/client";
import { closeSourcePools, dropSourcePool } from "@/lib/timescaledb/pool";

/**
 * The server half of the TimescaleDB kind: today's functions under
 * `src/lib/timescaledb/` and `src/lib/sql/`, gathered behind the kind rather
 * than imported by name from every route. Nothing here is new behavior; the
 * guard, the planner and the executor are the same functions.
 *
 * Credentials still resolve only in `src/lib/secrets/credentials.ts`, which
 * the functions this names call on every connection.
 */
export const timescaledbServer = {
  kind: "timescaledb",
  /** The guard: the statement against the catalog's allowlist. */
  validate: validateSql,
  /** Wrap a validated statement with the server's time window and limits. */
  plan: buildExecutablePlan,
  /** Run a plan, read-only, inside the source's pool. */
  execute: executePlan,
  /** What the session is put into before a plan runs, as shown in the plan dialog. */
  session: (cfg: { schema: string }) => sessionStatements(cfg.schema),
  /** Connectivity, identity and read-only proof. */
  test: testSource,
  /** The tables and columns a prospective source's user can see. */
  discover: discoverTables,
  /** Re-introspect the allowlisted tables' columns. */
  refresh: refreshCatalog,
  refreshDigest,
  /** The catalog as the model is shown it. */
  renderCatalog,
  /** The catalog block of the generation prompt. */
  catalogPrompt: buildCatalogPrompt,
  /** Release what the process holds for a source that is going away. */
  dispose: dropSourcePool,
  /** Release what the process holds for every source of the kind, at shutdown. */
  closeAll: closeSourcePools,
} as const;
