import { checkBaseUrl } from "@/lib/ai/guarded-fetch";
import { fenceUntrustedBlock, sanitizePromptField } from "@/lib/ai/untrusted";
import { diffLabelCatalog } from "@/lib/catalog/refresh";
import { config } from "@/lib/config";
import { isLogqlQuery, VARIABLE_VALUES_MAX } from "@/lib/ir";
import { lokiRefreshDigest, refreshLokiCatalog, testLoki } from "@/lib/loki/catalog";
import {
  type LokiTarget,
  LokiUnavailableError,
  logUnavailable,
  lokiRequest,
  lokiTime,
  runLogqlPlan,
} from "@/lib/loki/client";
import { rowsFromLoki } from "@/lib/loki/rows";
import {
  buildLogqlLabelValuesPlan,
  buildLogqlPlan,
  type LogqlLabelValuesPlan,
} from "@/lib/logql/plan";
import {
  defaultLogqlLimits,
  LogqlRefusal,
  validateLogql,
  validateLogqlLabelValues,
} from "@/lib/logql/safety";
import { logqlVariableNames } from "@/lib/logql/variables";
import { observeQuery, recordTruncation } from "@/lib/metrics";
import { durationMs } from "@/lib/promql/parse";
import { buildLogqlPlanView } from "@/lib/query-plan";
import type { SourceRecord } from "@/lib/registry";
import { trackInFlight } from "@/lib/shutdown";
import { QueryExecutionError, type QueryResult } from "@/lib/sources/execution";
import { type LokiConfig, loki } from "@/lib/sources/kinds/loki";
import { wrongLanguage } from "@/lib/sources/registry";
import { sourceUrlAllowlist } from "@/lib/sources/server/endpoint";
import type {
  QueryCheck,
  ServerSourceKind,
  SourcePlan,
} from "@/lib/sources/server/types";
import type { RowFilterBinding } from "@/lib/sql/row-filter";

/**
 * The server half of the Loki kind (#562): the LogQL guard
 * (`src/lib/logql/`), the plan it builds, and the HTTP client
 * (`src/lib/loki/`), behind the shape every kind has.
 *
 * The server picks `start`, `end`, `step`, `limit` and `direction`; every
 * response is bounded in time, bytes, entries and series before it becomes
 * rows; credentials resolve per request under the workspace grant; and an
 * endpoint failure is logged by source id and reaches the browser only as the
 * opaque infrastructure error.
 */

interface LokiSource extends SourceRecord {
  config: LokiConfig;
}

/** This kind only ever receives its own sources; anything else is a bug. */
function lokiSource(source: SourceRecord): LokiSource {
  if (source.config.kind !== "loki") {
    throw new Error(`${source.id} is not a Loki source`);
  }
  return source as LokiSource;
}

function target(source: LokiSource): LokiTarget {
  return {
    id: source.id,
    workspaceId: source.workspaceId,
    secretRef: source.secretRef,
    config: { url: source.config.url, auth: source.config.auth },
  };
}

/** `RowFilterBinding.column` is the kind's target: here, the tenant label. */
function tenant(binding: RowFilterBinding | null) {
  return binding ? { label: binding.column, value: binding.value } : null;
}

/** Guard refusals that reach the planner are the author's to fix. */
function asStatementError(err: unknown): never {
  if (err instanceof LogqlRefusal) throw new QueryExecutionError(err.message);
  throw err;
}

/** Infrastructure failures are logged here and rethrown for `route()` to make opaque. */
async function reach<T>(source: LokiSource, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof LokiUnavailableError) logUnavailable(target(source), err);
    throw err;
  }
}

const kind: ServerSourceKind = {
  kind: "loki",

  async check(source, query, declared): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !isLogqlQuery(query))
      return { ok: false, error: wrong ?? "not LogQL" };
    const result = validateLogql(
      query.logql,
      loki.catalog(lokiSource(source).config),
      declared,
    );
    if (result.ok && result.kind === "log" && query.instant) {
      // Loki runs a log query only over a range; say so before planning.
      return {
        ok: false,
        error:
          "a log query runs over the dashboard's range; it cannot be an instant query",
      };
    }
    return {
      ok: result.ok,
      error: result.error,
      ...(result.hints ? { hints: result.hints } : {}),
    };
  },

  async checkVariable(source, query): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !("label" in query))
      return { ok: false, error: wrong ?? "not LogQL" };
    const result = validateLogqlLabelValues(
      query,
      loki.catalog(lokiSource(source).config),
    );
    return { ok: result.ok, error: result.error };
  },

  plan(source, query, input): SourcePlan {
    if (!isLogqlQuery(query)) {
      throw new QueryExecutionError(wrongLanguage(source, query) ?? "not LogQL");
    }
    try {
      return {
        language: "logql",
        plan: buildLogqlPlan({
          logql: query.logql,
          instant: query.instant,
          minStep: query.minStep,
          from: input.from,
          to: input.to,
          catalog: loki.catalog(lokiSource(source).config),
          rowFilter: tenant(input.rowFilter),
          variables: input.variables,
          maxEntries: input.maxRows,
        }),
      };
    } catch (err) {
      return asStatementError(err);
    }
  },

  execute(source, plan): Promise<QueryResult> {
    const src = lokiSource(source);
    if (plan.language !== "logql") throw new Error("a Loki source runs LogQL plans only");
    const logql = plan.plan;
    return trackInFlight(async () => {
      const startedAt = performance.now();
      try {
        const data = await reach(src, () => runLogqlPlan(target(src), logql));
        const result = rowsFromLoki(data, {
          maxSeries: config.lokiMaxSeries,
          limit: logql.kind === "log" ? logql.limit : Number.POSITIVE_INFINITY,
          direction: logql.kind === "log" ? logql.direction : "backward",
        });
        if (result.truncated) recordTruncation(result.truncated.stage);
        // A step the point cap widened draws the window coarser than the
        // source holds it (#486); say so rather than let it pass as whole.
        const finest =
          logql.kind === "metric" && !logql.instant ? logql.finestPoints : undefined;
        if (finest !== undefined && result.rows.length > 0) {
          result.truncated = { stage: "points", kept: result.rows.length, total: finest };
          recordTruncation("points");
        }
        observeQuery({
          sourceId: src.id,
          seconds: (performance.now() - startedAt) / 1000,
          ok: true,
          rows: result.rows.length,
        });
        return result;
      } catch (err) {
        observeQuery({
          sourceId: src.id,
          seconds: (performance.now() - startedAt) / 1000,
          ok: false,
        });
        throw err;
      }
    });
  },

  async labelValues(source, query, rowFilter): Promise<string[]> {
    const src = lokiSource(source);
    if (!("label" in query))
      throw new QueryExecutionError(wrongLanguage(source, query) ?? "not LogQL");
    let plan: LogqlLabelValuesPlan;
    try {
      plan = buildLogqlLabelValuesPlan({
        label: query.label,
        match: query.match,
        catalog: loki.catalog(src.config),
        rowFilter: tenant(rowFilter),
      });
    } catch (err) {
      return asStatementError(err);
    }
    // Bounded like any query: the last LOGQL_MAX_RANGE, never all time.
    const now = Date.now();
    const lookback = durationMs(config.logqlMaxRange) ?? 7 * 86_400_000;
    const params = new URLSearchParams({
      start: lokiTime(new Date(now - lookback)),
      end: lokiTime(new Date(now)),
    });
    if (plan.query !== undefined) params.set("query", plan.query);
    const data = await trackInFlight(() =>
      reach(src, () =>
        lokiRequest(
          target(src),
          `label/${encodeURIComponent(plan.label)}/values`,
          params,
          {
            timeoutMs: plan.timeoutMs,
          },
        ),
      ),
    );
    const values = Array.isArray(data)
      ? data.filter((v): v is string => typeof v === "string")
      : [];
    return [...new Set(values)].sort().slice(0, VARIABLE_VALUES_MAX);
  },

  planView({ source, query, plan, timeRange, variables }) {
    const src = lokiSource(source);
    if (!isLogqlQuery(query) || plan.language !== "logql") {
      throw new Error("a Loki plan view needs a LogQL query and plan");
    }
    return buildLogqlPlanView({
      logql: query.logql,
      minStep: query.minStep,
      timeRange,
      plan: plan.plan,
      rowFilterClaim: src.config.rowFilter?.claim,
      variables: logqlVariableNames(query.logql, defaultLogqlLimits()).flatMap((name) => {
        const value = variables?.[name];
        return value === undefined ? [] : [{ name, value }];
      }),
      limits: {
        maxResultBytes: config.maxResultBytes,
        maxEntries: config.lokiMaxEntries,
        maxSeries: config.lokiMaxSeries,
        maxPoints: config.promqlMaxPoints,
        minStepMs: config.prometheusMinStepMs,
      },
    });
  },

  async checkConfig(cfg) {
    if (cfg.kind !== "loki") return null;
    return checkBaseUrl(cfg.url, sourceUrlAllowlist());
  },

  refresh(source) {
    const src = lokiSource(source);
    return reach(src, () => refreshLokiCatalog(target(src), src.config));
  },
  refreshDiff(source, refresh) {
    const src = lokiSource(source);
    if (refresh.config.kind !== "loki")
      throw new Error("a Loki refresh holds its config");
    return diffLabelCatalog(src, {
      config: refresh.config,
      missingTables: refresh.missingTables,
    });
  },
  refreshDigest(refresh) {
    if (refresh.config.kind !== "loki")
      throw new Error("a Loki refresh holds its config");
    return lokiRefreshDigest({
      config: refresh.config,
      missingTables: refresh.missingTables,
    });
  },
  catalogView(source, catalogHealth, canManage) {
    const src = lokiSource(source);
    return {
      labels: loki.catalog(src.config).labels,
      missingLabels: [...src.catalogMissingTables],
      catalogHealth,
      canManage,
    };
  },

  test(source) {
    const src = lokiSource(source);
    return trackInFlight(() => testLoki(target(src), src.config));
  },

  // Nothing about a Loki server changes what the model is told.
  testFacts: () => undefined,

  renderCatalog(source) {
    const src = lokiSource(source);
    const f = sanitizePromptField;
    const lines = [
      `Source: ${f(src.name, 200)} (id: ${f(src.id, 128)}, kind: loki)`,
      "Stream labels (every stream selector needs an = matcher on at least one of these):",
    ];
    const missing = new Set(src.catalogMissingTables);
    for (const label of src.config.labels) {
      if (missing.has(label.name)) continue;
      const values =
        label.values.length > 0
          ? ` -- values seen: ${label.values
              .slice(0, 20)
              .map((v) => f(v, 128))
              .join(", ")}${label.values.length > 20 ? ", …" : ""}`
          : "";
      lines.push(`- ${f(label.name, 128)}${values}`);
    }
    return lines.join("\n");
  },

  catalogPrompt(source) {
    return fenceUntrustedBlock("CATALOG", kind.renderCatalog(source));
  },

  rowFilterProblem(cfg) {
    if (cfg.kind !== "loki" || !cfg.rowFilter) return null;
    const label = cfg.rowFilter.label;
    return cfg.labels.some((l) => l.name === label)
      ? null
      : `the tenant label "${label}" must be one of the source's labels`;
  },

  dispose: async () => {},
  closeAll: async () => {},
};

export const lokiServer = kind;
