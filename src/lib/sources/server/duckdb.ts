import { config } from "@/lib/config";
import { isSqlQuery } from "@/lib/ir";
import { buildQueryPlanView } from "@/lib/query-plan";
import { catalogView } from "@/lib/catalog/browse";
import { refreshDigest } from "@/lib/catalog/introspection";
import { diffCatalog } from "@/lib/catalog/refresh";
import type { SourceConfig, SourceRecord } from "@/lib/registry";
import type { SourceTestResult } from "@/lib/source-test";
import { QueryExecutionError } from "@/lib/sources/execution";
import {
  type DuckDbConfig,
  type DuckDbSourceRecord,
  duckdbLayout,
} from "@/lib/sources/kinds/duckdb";
import { wrongLanguage } from "@/lib/sources/registry";
import type {
  QueryCheck,
  ServerSourceKind,
  SourcePlan,
} from "@/lib/sources/server/types";
import { rowFilterProblem } from "@/lib/sql/row-filter";
import { buildExecutablePlan, type SqlDialect, validateSql } from "@/lib/sql/safety";
import { DUCKDB_UNAVAILABLE, duckdbBinding } from "@/lib/duckdb/binding";
import {
  buildDuckDbCatalogPrompt,
  refreshDuckDbCatalog,
  renderDuckDbCatalog,
} from "@/lib/duckdb/catalog";
import {
  closeDuckDbSources,
  disposeDuckDbSource,
  executeDuckDbPlan,
  sessionStatements,
  testDuckDbSource,
} from "@/lib/duckdb/client";
import { DuckDbPathError, resolveSourcePath, SOURCES_DIR_UNSET } from "@/lib/duckdb/path";

/**
 * The server half of the DuckDB kind (#572): the same SQL guard and planner
 * as TimescaleDB, in front of an in-process engine (`src/lib/duckdb/`) that is
 * locked before anything runs. A DuckDB source names no `secret_ref`; what it
 * may read is decided by `DUCKDB_SOURCES_DIR` and the path guard, on save and
 * again on every open.
 */

/** This kind only ever receives its own sources; anything else is a bug. */
function duckSource(source: SourceRecord): DuckDbSourceRecord {
  if (source.config.kind !== "duckdb") {
    throw new Error(`${source.id} is not a DuckDB source`);
  }
  return source as DuckDbSourceRecord;
}

function duckConfig(cfg: SourceConfig): DuckDbConfig {
  if (cfg.kind !== "duckdb") throw new Error("a DuckDB refresh holds a DuckDB config");
  return cfg;
}

function sqlPlan(plan: SourcePlan) {
  if (plan.language !== "sql") throw new Error("a DuckDB source runs SQL plans only");
  return plan.plan;
}

/**
 * How DuckDB spells what the plan's wrapper adds: the window's bounds are
 * bound as UTC `TIMESTAMP`s. The engine's TimeZone is UTC (set when it is
 * opened, then locked), so a `TIMESTAMPTZ` column compares to them as the
 * instant it is, and a zoneless `TIMESTAMP` column is read as UTC.
 */
export const DUCKDB_DIALECT: SqlDialect = { timestampCast: "TIMESTAMP" };

/**
 * Why a DuckDB config cannot be saved on this server, or null: the kind is
 * off (`DUCKDB_SOURCES_DIR` unset), the binding did not load, or the path
 * does not resolve to a directory or a `.duckdb` file inside the root.
 */
export async function duckdbConfigProblem(cfg: DuckDbConfig): Promise<string | null> {
  try {
    await resolveSourcePath(cfg.path);
  } catch (err) {
    if (err instanceof DuckDbPathError) return err.message;
    throw err;
  }
  if (!(await duckdbBinding())) return DUCKDB_UNAVAILABLE;
  return null;
}

/**
 * Why no DuckDB source can be added on this server, or null (#573): the kind
 * is off (`DUCKDB_SOURCES_DIR` unset) or the binding did not load. The Add
 * source dialog hides the kind's card for either; `duckdbConfigProblem`
 * still runs on every save.
 */
export async function duckdbAvailability(): Promise<string | null> {
  if (!config.duckdbSourcesDir) return SOURCES_DIR_UNSET;
  if (!(await duckdbBinding())) return DUCKDB_UNAVAILABLE;
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const kind: ServerSourceKind = {
  kind: "duckdb",

  async check(source, query, declared): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !isSqlQuery(query))
      return { ok: false, error: wrong ?? "not SQL" };
    return validateSql(query.sql, duckSource(source).config, declared);
  },

  async checkVariable(source, query): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !isSqlQuery(query))
      return { ok: false, error: wrong ?? "not SQL" };
    return validateSql(query.sql, duckSource(source).config);
  },

  plan(source, query, input): SourcePlan {
    if (!isSqlQuery(query)) {
      throw new QueryExecutionError(wrongLanguage(source, query) ?? "not SQL");
    }
    return {
      language: "sql",
      plan: buildExecutablePlan(
        {
          sql: query.sql,
          timeField: query.timeField,
          from: input.from,
          to: input.to,
          rowFilter: input.rowFilter,
          variables: input.variables,
          maxRows: input.maxRows,
        },
        { dialect: DUCKDB_DIALECT },
      ),
    };
  },

  execute(source, plan) {
    return executeDuckDbPlan(duckSource(source), sqlPlan(plan));
  },

  async labelValues(source) {
    throw new QueryExecutionError(
      `source "${source.id}" answers SQL; a label-values variable is PromQL`,
    );
  },

  planView({ source, query, plan, timeRange }) {
    const duck = duckSource(source);
    if (!isSqlQuery(query)) throw new Error("a DuckDB plan view needs a SQL query");
    return buildQueryPlanView({
      sql: query.sql,
      timeField: query.timeField,
      timeRange,
      plan: sqlPlan(plan),
      rowFilterClaim: duck.config.rowFilter?.claim,
      session: sessionStatements(duckdbLayout(duck.config.path)),
      limits: {
        maxRows: config.maxQueryRows,
        statementTimeoutMs: config.queryTimeoutSeconds * 1000,
        maxResultBytes: config.maxResultBytes,
      },
    });
  },

  checkConfig: async (cfg) => (cfg.kind === "duckdb" ? duckdbConfigProblem(cfg) : null),
  availability: duckdbAvailability,
  refresh: (source) => refreshDuckDbCatalog(duckSource(source)),
  refreshDiff: (source, refresh) =>
    diffCatalog(duckSource(source), {
      config: duckConfig(refresh.config),
      missingTables: refresh.missingTables,
    }),
  refreshDigest: (refresh) =>
    refreshDigest({
      config: duckConfig(refresh.config),
      missingTables: refresh.missingTables,
    }),
  catalogView: (source, health, canManage) =>
    catalogView(duckSource(source), health, canManage),

  async test(source): Promise<SourceTestResult> {
    const duck = duckSource(source);
    let facts: Awaited<ReturnType<typeof testDuckDbSource>>;
    try {
      facts = await testDuckDbSource(duck);
    } catch (err) {
      // Path-free by construction: the path guard's refusals and the
      // engine's scrubbed messages, or the binding's unavailability.
      return { ok: false, message: errorMessage(err) };
    }
    return {
      ok: facts.locked,
      message: facts.locked
        ? "the engine opened and its configuration is locked"
        : "the engine opened but its configuration is not locked",
      latency: { connectMs: facts.openMs, queryMs: facts.queryMs },
      server: { version: `DuckDB ${facts.version}`, timescaledb: null },
      layout: duckdbLayout(duck.config.path),
      lock: {
        holds: facts.locked,
        detail: facts.locked
          ? "enable_external_access is false and lock_configuration is true on the connection"
          : "the connection reports external access on or the configuration unlocked",
      },
      tables: facts.tables,
    };
  },
  testFacts: (result) =>
    result.ok && result.server
      ? { duckdb: result.server.version.replace(/^DuckDB /, "").slice(0, 64) }
      : undefined,
  renderCatalog: (source) => renderDuckDbCatalog(duckSource(source)),
  catalogPrompt: (source) => buildDuckDbCatalogPrompt(duckSource(source)),
  rowFilterProblem: (cfg) => (cfg.kind === "duckdb" ? rowFilterProblem(cfg) : null),
  dispose: disposeDuckDbSource,
  closeAll: closeDuckDbSources,
};

export const duckdbServer = kind;
