import { fenceUntrustedBlock, sanitizePromptField } from "@/lib/ai/untrusted";
import { config } from "@/lib/config";
import { isPromqlQuery, VARIABLE_VALUES_MAX } from "@/lib/ir";
import { observeQuery } from "@/lib/metrics";
import { checkBaseUrl } from "@/lib/ai/guarded-fetch";
import {
  logUnavailable,
  PrometheusUnavailableError,
  type PrometheusTarget,
  prometheusRequest,
  runPromqlPlan,
  sourceUrlAllowlist,
} from "@/lib/prometheus/client";
import {
  prometheusRefreshDigest,
  refreshPrometheusCatalog,
  testPrometheus,
} from "@/lib/prometheus/catalog";
import { rowsFromPrometheus } from "@/lib/prometheus/rows";
import { diffMetricCatalog } from "@/lib/catalog/refresh";
import { prometheus } from "@/lib/sources/kinds/prometheus";
import { durationMs } from "@/lib/promql/parse";
import { buildLabelValuesPlan, buildPromqlPlan } from "@/lib/promql/plan";
import {
  defaultLimits,
  PromqlRefusal,
  validatePromql,
  validatePromqlLabelValues,
} from "@/lib/promql/safety";
import { promqlVariableNames } from "@/lib/promql/variables";
import { buildPromqlPlanView } from "@/lib/query-plan";
import type { SourceRecord } from "@/lib/registry";
import { trackInFlight } from "@/lib/shutdown";
import { QueryExecutionError, type QueryResult } from "@/lib/sources/execution";
import type { PrometheusConfig } from "@/lib/sources/kinds/prometheus";
import { wrongLanguage } from "@/lib/sources/registry";
import type {
  QueryCheck,
  ServerSourceKind,
  SourcePlan,
} from "@/lib/sources/server/types";
import type { RowFilterBinding } from "@/lib/sql/row-filter";

/**
 * The server half of the Prometheus kind (#385): the PromQL guard
 * (`src/lib/promql/`), the plan it builds, and the HTTP client
 * (`src/lib/prometheus/`), behind the shape every kind has.
 *
 * The server picks `start`, `end` and `step`; every response is bounded in
 * time, bytes and series before it becomes rows; credentials resolve per
 * request under the workspace grant; and an endpoint failure is logged by
 * source id and reaches the browser only as the opaque infrastructure error.
 */

interface PrometheusSource extends SourceRecord {
  config: PrometheusConfig;
}

/** This kind only ever receives its own sources; anything else is a bug. */
function promSource(source: SourceRecord): PrometheusSource {
  if (source.config.kind !== "prometheus") {
    throw new Error(`${source.id} is not a Prometheus source`);
  }
  return source as PrometheusSource;
}

function target(source: PrometheusSource): PrometheusTarget {
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
  if (err instanceof PromqlRefusal) throw new QueryExecutionError(err.message);
  throw err;
}

/** Infrastructure failures are logged here and rethrown for `route()` to make opaque. */
async function reach<T>(source: PrometheusSource, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof PrometheusUnavailableError) logUnavailable(target(source), err);
    throw err;
  }
}

const kind: ServerSourceKind = {
  kind: "prometheus",

  async check(source, query, declared): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !isPromqlQuery(query))
      return { ok: false, error: wrong ?? "not PromQL" };
    const result = validatePromql(query.promql, promSource(source).config, declared);
    return {
      ok: result.ok,
      error: result.error,
      ...(result.hints ? { hints: result.hints } : {}),
    };
  },

  async checkVariable(source, query): Promise<QueryCheck> {
    const wrong = wrongLanguage(source, query);
    if (wrong !== null || !("label" in query))
      return { ok: false, error: wrong ?? "not PromQL" };
    const result = validatePromqlLabelValues(query, promSource(source).config);
    return { ok: result.ok, error: result.error };
  },

  plan(source, query, input): SourcePlan {
    if (!isPromqlQuery(query)) {
      throw new QueryExecutionError(wrongLanguage(source, query) ?? "not PromQL");
    }
    try {
      return {
        language: "promql",
        plan: buildPromqlPlan({
          promql: query.promql,
          instant: query.instant,
          minStep: query.minStep,
          from: input.from,
          to: input.to,
          rowFilter: tenant(input.rowFilter),
          variables: input.variables,
        }),
      };
    } catch (err) {
      return asStatementError(err);
    }
  },

  execute(source, plan): Promise<QueryResult> {
    const prom = promSource(source);
    if (plan.language !== "promql")
      throw new Error("a Prometheus source runs PromQL plans only");
    return trackInFlight(async () => {
      const startedAt = performance.now();
      try {
        const data = await reach(prom, () => runPromqlPlan(target(prom), plan.plan));
        const result = rowsFromPrometheus(data, config.prometheusMaxSeries);
        observeQuery({
          sourceId: prom.id,
          seconds: (performance.now() - startedAt) / 1000,
          ok: true,
          rows: result.rows.length,
        });
        return result;
      } catch (err) {
        observeQuery({
          sourceId: prom.id,
          seconds: (performance.now() - startedAt) / 1000,
          ok: false,
        });
        throw err;
      }
    });
  },

  async labelValues(source, query, rowFilter): Promise<string[]> {
    const prom = promSource(source);
    if (!("label" in query))
      throw new QueryExecutionError(wrongLanguage(source, query) ?? "not PromQL");
    let plan: ReturnType<typeof buildLabelValuesPlan>;
    try {
      plan = buildLabelValuesPlan({
        label: query.label,
        match: query.match,
        catalog: prom.config,
        rowFilter: tenant(rowFilter),
      });
    } catch (err) {
      return asStatementError(err);
    }
    // Bounded like any query: the last PROMQL_MAX_RANGE, never all time.
    const now = Date.now();
    const lookback = durationMs(config.promqlMaxRange) ?? 7 * 86_400_000;
    const form = new URLSearchParams({
      start: ((now - lookback) / 1000).toFixed(3),
      end: (now / 1000).toFixed(3),
    });
    for (const m of plan.match) form.append("match[]", m);
    const data = await trackInFlight(() =>
      reach(prom, () =>
        prometheusRequest(
          target(prom),
          `label/${encodeURIComponent(plan.label)}/values`,
          form,
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
    const prom = promSource(source);
    if (!isPromqlQuery(query) || plan.language !== "promql") {
      throw new Error("a Prometheus plan view needs a PromQL query and plan");
    }
    return buildPromqlPlanView({
      promql: query.promql,
      minStep: query.minStep,
      timeRange,
      plan: plan.plan,
      rowFilterClaim: prom.config.rowFilter?.claim,
      variables: promqlVariableNames(query.promql, defaultLimits()).flatMap((name) => {
        const value = variables?.[name];
        return value === undefined ? [] : [{ name, value }];
      }),
      limits: {
        maxResultBytes: config.maxResultBytes,
        maxSeries: config.prometheusMaxSeries,
        maxPoints: config.promqlMaxPoints,
        minStepMs: config.prometheusMinStepMs,
      },
    });
  },

  async checkConfig(cfg) {
    if (cfg.kind !== "prometheus") return null;
    return checkBaseUrl(cfg.url, sourceUrlAllowlist());
  },

  refresh(source) {
    const prom = promSource(source);
    return reach(prom, () => refreshPrometheusCatalog(target(prom), prom.config));
  },
  refreshDiff(source, refresh) {
    const prom = promSource(source);
    if (refresh.config.kind !== "prometheus")
      throw new Error("a Prometheus refresh holds its config");
    return diffMetricCatalog(prom, {
      config: refresh.config,
      missingTables: refresh.missingTables,
    });
  },
  refreshDigest(refresh) {
    if (refresh.config.kind !== "prometheus")
      throw new Error("a Prometheus refresh holds its config");
    return prometheusRefreshDigest({
      config: refresh.config,
      missingTables: refresh.missingTables,
    });
  },
  catalogView(source, catalogHealth, canManage) {
    const prom = promSource(source);
    return {
      metrics: prometheus.catalog(prom.config).metrics,
      missingMetrics: [...prom.catalogMissingTables],
      catalogHealth,
      canManage,
    };
  },

  test(source) {
    const prom = promSource(source);
    return trackInFlight(() => testPrometheus(target(prom), prom.config));
  },

  renderCatalog(source) {
    const prom = promSource(source);
    const f = sanitizePromptField;
    const lines = [
      `Source: ${f(prom.name, 200)} (id: ${f(prom.id, 128)}, kind: prometheus)`,
      "Metrics (only these may be queried):",
    ];
    const missing = new Set(prom.catalogMissingTables);
    for (const m of prom.config.metrics) {
      if (missing.has(m.name)) continue;
      const help = m.help ? ` -- ${f(m.help, 500)}` : "";
      lines.push(`- ${f(m.name, 256)} (${m.type})${help}`);
      if (m.labels.length > 0)
        lines.push(`    labels: ${m.labels.map((l) => f(l, 128)).join(", ")}`);
    }
    return lines.join("\n");
  },

  catalogPrompt(source) {
    return fenceUntrustedBlock("CATALOG", kind.renderCatalog(source));
  },

  rowFilterProblem(cfg) {
    if (cfg.kind !== "prometheus" || !cfg.rowFilter) return null;
    const label = cfg.rowFilter.label;
    const without = cfg.metrics
      .filter((m) => !m.labels.includes(label))
      .map((m) => m.name);
    return without.length === 0
      ? null
      : `the tenant label "${label}" must be a label of every metric; ${without.join(", ")} ${without.length === 1 ? "does" : "do"} not list it`;
  },

  dispose: async () => {},
  closeAll: async () => {},
};

export const prometheusServer = kind;
