import { config } from "@/lib/config";
import { isSqlQuery } from "@/lib/ir";
import { buildQueryPlanView } from "@/lib/query-plan";
import { catalogView } from "@/lib/catalog/browse";
import { diffCatalog } from "@/lib/catalog/refresh";
import type {
  SourceConfig,
  SourceRecord,
  SqlSourceConfig,
  SqlSourceRecord,
} from "@/lib/registry";
import { QueryExecutionError } from "@/lib/sources/execution";
import { wrongLanguage } from "@/lib/sources/registry";
import type {
  QueryCheck,
  ServerSourceKind,
  SourcePlan,
} from "@/lib/sources/server/types";
import { rowFilterProblem } from "@/lib/sql/row-filter";
import { buildExecutablePlan, validateSql } from "@/lib/sql/safety";
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
 * The server half of the TimescaleDB kind: the guard, planner and executor
 * under `src/lib/sql/` and `src/lib/timescaledb/`, behind the shape every kind
 * has (`ServerSourceKind`). Nothing here changes what runs; it is the same
 * `validateSql`, `buildExecutablePlan` and `executePlan`.
 *
 * Credentials still resolve only in `src/lib/secrets/credentials.ts`, which
 * the functions this names call on every connection.
 */

/** This kind only ever receives its own sources; anything else is a bug. */
function sqlSource(source: SourceRecord): SqlSourceRecord {
  if (source.config.kind !== "timescaledb") {
    throw new Error(`${source.id} is not a TimescaleDB source`);
  }
  return source as SqlSourceRecord;
}

function sqlConfig(cfg: SourceConfig): SqlSourceConfig {
  if (cfg.kind !== "timescaledb")
    throw new Error("a TimescaleDB refresh holds a SQL config");
  return cfg;
}

function sqlPlan(plan: SourcePlan) {
  if (plan.language !== "sql")
    throw new Error("a TimescaleDB source runs SQL plans only");
  return plan.plan;
}

const kind: ServerSourceKind = {
  kind: "timescaledb",

  async check(source, query, declared): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !isSqlQuery(query))
      return { ok: false, error: wrong ?? "not SQL" };
    return validateSql(query.sql, sqlSource(source).config, declared);
  },

  async checkVariable(source, query): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !isSqlQuery(query))
      return { ok: false, error: wrong ?? "not SQL" };
    return validateSql(query.sql, sqlSource(source).config);
  },

  plan(source, query, input): SourcePlan {
    if (!isSqlQuery(query)) {
      throw new QueryExecutionError(wrongLanguage(source, query) ?? "not SQL");
    }
    return {
      language: "sql",
      plan: buildExecutablePlan({
        sql: query.sql,
        timeField: query.timeField,
        from: input.from,
        to: input.to,
        rowFilter: input.rowFilter,
        variables: input.variables,
      }),
    };
  },

  execute(source, plan) {
    return executePlan(sqlSource(source), sqlPlan(plan));
  },

  async labelValues(source) {
    throw new QueryExecutionError(
      `source "${source.id}" answers SQL; a label-values variable is PromQL`,
    );
  },

  planView({ source, query, plan, timeRange }) {
    const sql = sqlSource(source);
    if (!isSqlQuery(query)) throw new Error("a TimescaleDB plan view needs a SQL query");
    return buildQueryPlanView({
      sql: query.sql,
      timeField: query.timeField,
      timeRange,
      plan: sqlPlan(plan),
      rowFilterClaim: sql.config.rowFilter?.claim,
      session: sessionStatements(sql.config.schema),
      limits: {
        maxRows: config.maxQueryRows,
        statementTimeoutMs: config.queryTimeoutSeconds * 1000,
        maxResultBytes: config.maxResultBytes,
      },
    });
  },

  // A database host is the operator's grant (`SOURCE_SECRET_REFS`), not an
  // address check; nothing more to look at when it is saved.
  checkConfig: async () => null,
  refresh: (source) => refreshCatalog(sqlSource(source)),
  refreshDiff: (source, refresh) =>
    diffCatalog(sqlSource(source), {
      config: sqlConfig(refresh.config),
      missingTables: refresh.missingTables,
    }),
  refreshDigest: (refresh) =>
    refreshDigest({
      config: sqlConfig(refresh.config),
      missingTables: refresh.missingTables,
    }),
  catalogView: (source, health, canManage) =>
    catalogView(sqlSource(source), health, canManage),
  test: (source) => testSource(sqlSource(source)),
  renderCatalog: (source) => renderCatalog(sqlSource(source)),
  catalogPrompt: (source) => buildCatalogPrompt(sqlSource(source)),
  rowFilterProblem: (cfg) => (cfg.kind === "timescaledb" ? rowFilterProblem(cfg) : null),
  dispose: dropSourcePool,
  closeAll: closeSourcePools,
};

/**
 * Catalog management only SQL sources have until the Prometheus form,
 * discovery and refresh land (#386): reached through `sqlCatalogManagement`
 * in the server registry, which hands it only a SQL source.
 */
export const timescaledbManagement = {
  discover: discoverTables,
  refresh: (source: SqlSourceRecord) => refreshCatalog(source),
  refreshDigest,
};

export const timescaledbServer = kind;
