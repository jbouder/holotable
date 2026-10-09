import { createHash } from "node:crypto";
import { config } from "@/lib/config";
import {
  type PrometheusTarget,
  PrometheusUnavailableError,
  prometheusPing,
  prometheusRequest,
} from "@/lib/prometheus/client";
import { durationMs, stringLiteral } from "@/lib/promql/parse";
import type { SourceTestResult, TestMetric, TestWriteSurface } from "@/lib/source-test";
import {
  MAX_LABELS,
  MAX_METRICS,
  type PrometheusConfig,
  PrometheusConfig as PrometheusConfigSchema,
  PrometheusMetric,
} from "@/lib/sources/kinds/prometheus";

/**
 * A Prometheus source's catalog, from its endpoint (#386): the metrics it
 * knows, the labels their series carry, and the connection test. Everything
 * here runs with the source's own credential through the same guarded fetch
 * as a query, so discovery can show no more than execution could read.
 */

/** One entry of the discovery menu. A menu, not an allowlist. */
export interface DiscoveredMetric {
  name: string;
  type: PrometheusMetric["type"];
  help?: string;
}

const TYPES = new Set(["counter", "gauge", "histogram", "summary"]);

function windowMs(): number {
  return durationMs(config.prometheusDiscoveryWindow) ?? 3_600_000;
}

function windowForm(extra: Record<string, string> = {}): URLSearchParams {
  const end = Date.now();
  const start = end - windowMs();
  return new URLSearchParams({
    start: (start / 1000).toFixed(3),
    end: (end / 1000).toFixed(3),
    ...extra,
  });
}

const timeouts = () => ({ timeoutMs: config.queryTimeoutSeconds * 1000 });

/** A selector for exactly one metric, by name, whatever characters it has. */
export function metricSelector(name: string): string {
  return `{__name__=${stringLiteral(name)}}`;
}

/**
 * The series names a metric family is queried by. Metadata names a family;
 * a classic histogram's series are `_bucket` (what `histogram_quantile` reads),
 * `_count` and `_sum`, which are counters, and a summary adds those two to its
 * quantile series. The allowlist holds the names a selector uses.
 */
function seriesNames(
  family: string,
  type: DiscoveredMetric["type"],
): { name: string; type: DiscoveredMetric["type"] }[] {
  const totals = [
    { name: `${family}_count`, type: "counter" as const },
    { name: `${family}_sum`, type: "counter" as const },
  ];
  if (type === "histogram") return [{ name: `${family}_bucket`, type }, ...totals];
  if (type === "summary") return [{ name: family, type }, ...totals];
  return [{ name: family, type }];
}

/**
 * Every metric the endpoint describes, from `/api/v1/metadata`; an endpoint
 * that keeps no metadata (VictoriaMetrics, some Mimir setups) answers names
 * only, from `__name__`'s values over the discovery window.
 */
export async function discoverMetrics(
  target: PrometheusTarget,
): Promise<DiscoveredMetric[]> {
  const metadata = await prometheusRequest(target, "metadata", new URLSearchParams(), {
    ...timeouts(),
    method: "GET",
  }).catch((err) => {
    if (err instanceof PrometheusUnavailableError && err.status === 404) return {};
    throw err;
  });
  const described = Object.entries(
    (metadata ?? {}) as Record<string, { type?: string; help?: string }[]>,
  )
    .flatMap(([name, entries]) => {
      const first = entries?.[0] ?? {};
      const type = (
        TYPES.has(first.type ?? "") ? first.type : "unknown"
      ) as DiscoveredMetric["type"];
      return seriesNames(name, type).map((series) => ({
        name: series.name,
        type: series.type,
        ...(first.help ? { help: first.help.slice(0, 500) } : {}),
      }));
    })
    .filter((m) => PrometheusMetric.shape.name.safeParse(m.name).success);
  if (described.length > 0) return described.sort((a, b) => a.name.localeCompare(b.name));

  const names = await prometheusRequest(target, "label/__name__/values", windowForm(), {
    ...timeouts(),
    method: "GET",
  });
  return (Array.isArray(names) ? names : [])
    .filter((n): n is string => typeof n === "string")
    .filter((n) => PrometheusMetric.shape.name.safeParse(n).success)
    .sort()
    .map((name) => ({ name, type: "unknown" as const }));
}

/** Run `work` over `items`, a few at a time, keeping their order. */
async function eachBounded<T, R>(
  items: T[],
  work: (item: T) => Promise<R>,
  limit = 8,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * The label names each metric's series carry over the discovery window, from
 * `/api/v1/labels?match[]=`. A metric with no series in the window has none,
 * which a refresh reads as missing.
 */
export async function discoverLabels(
  target: PrometheusTarget,
  metrics: string[],
): Promise<Record<string, string[]>> {
  const picked = [...new Set(metrics)].slice(0, MAX_METRICS);
  const labels = await eachBounded(picked, async (name) => {
    const form = windowForm();
    form.append("match[]", metricSelector(name));
    const data = await prometheusRequest(target, "labels", form, timeouts());
    return (Array.isArray(data) ? data : [])
      .filter((l): l is string => typeof l === "string" && l !== "__name__")
      .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(l))
      .sort()
      .slice(0, MAX_LABELS);
  });
  return Object.fromEntries(picked.map((name, i) => [name, labels[i]]));
}

export interface PrometheusCatalogRefresh {
  config: PrometheusConfig;
  /** Allowlisted metrics with no series in the discovery window. */
  missingTables: string[];
}

/**
 * The allowlist re-read from the endpoint. Like a SQL refresh, the allowlist
 * is the author's: no metric is added or dropped. A metric with series gets
 * its labels and type as they are now; one without keeps its last known
 * labels and is reported missing.
 */
export async function refreshPrometheusCatalog(
  target: PrometheusTarget,
  current: PrometheusConfig,
): Promise<PrometheusCatalogRefresh> {
  const described = new Map(
    (await discoverMetrics(target).catch(() => [])).map((m) => [m.name, m]),
  );
  const labels = await discoverLabels(
    target,
    current.metrics.map((m) => m.name),
  );
  const missingTables: string[] = [];
  const metrics = current.metrics.map((metric) => {
    const found = labels[metric.name] ?? [];
    const meta = described.get(metric.name);
    if (found.length === 0) {
      missingTables.push(metric.name);
      return metric;
    }
    return {
      ...metric,
      labels: found,
      ...(meta ? { type: meta.type, ...(meta.help ? { help: meta.help } : {}) } : {}),
    };
  });
  return {
    config: PrometheusConfigSchema.parse({ ...current, metrics }),
    missingTables,
  };
}

/** The digest an apply must send back: the same catalog, or a conflict. */
export function prometheusRefreshDigest(refresh: PrometheusCatalogRefresh): string {
  return createHash("sha256")
    .update(
      JSON.stringify({ metrics: refresh.config.metrics, missing: refresh.missingTables }),
    )
    .digest("hex");
}

/** The flags that let a request write or delete through the endpoint. */
const WRITE_FLAGS = [
  "web.enable-admin-api",
  "web.enable-remote-write-receiver",
  "web.enable-otlp-receiver",
];

async function writeSurface(target: PrometheusTarget): Promise<TestWriteSurface> {
  try {
    const flags = (await prometheusRequest(
      target,
      "status/flags",
      new URLSearchParams(),
      {
        ...timeouts(),
        method: "GET",
      },
    )) as Record<string, string> | null;
    const open = WRITE_FLAGS.filter((f) => flags?.[f] === "true");
    return open.length > 0
      ? {
          verdict: "open",
          detail: `${open.join(", ")} ${open.length === 1 ? "is" : "are"} on.`,
        }
      : { verdict: "closed", detail: `${WRITE_FLAGS.join(", ")}: off.` };
  } catch (err) {
    return {
      verdict: "unknown",
      detail:
        err instanceof PrometheusUnavailableError && err.status === 404
          ? "The endpoint does not publish /api/v1/status/flags."
          : "The flags could not be read.",
    };
  }
}

async function metricReachability(
  target: PrometheusTarget,
  metrics: string[],
): Promise<TestMetric[]> {
  const window = config.prometheusDiscoveryWindow;
  return eachBounded(metrics, async (metric) => {
    const form = windowForm({ limit: "1" });
    form.append("match[]", metricSelector(metric));
    try {
      const series = await prometheusRequest(target, "series", form, timeouts());
      return Array.isArray(series) && series.length > 0
        ? { metric, reachable: true }
        : { metric, reachable: false, error: `no series in the last ${window}` };
    } catch (err) {
      return {
        metric,
        reachable: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}

function productOf(build: Record<string, unknown> | null): {
  product: string;
  version: string | null;
} {
  const version = typeof build?.version === "string" ? build.version : null;
  const text = JSON.stringify(build ?? {}).toLowerCase();
  const product = text.includes("thanos")
    ? "Thanos"
    : text.includes("victoria")
      ? "VictoriaMetrics"
      : text.includes("mimir")
        ? "Mimir"
        : version !== null
          ? "Prometheus"
          : "a Prometheus-compatible API";
  return { product, version };
}

/**
 * Connectivity, the build, the auth, the write surface and every
 * allowlisted metric's series (#386). Nothing here writes: the write surface
 * is read from the flags, never probed.
 */
export async function testPrometheus(
  target: PrometheusTarget,
  cfg: PrometheusConfig,
): Promise<SourceTestResult> {
  const t0 = performance.now();
  const ready = await prometheusPing(target, "/-/ready", timeouts()).catch(() => null);
  const connectMs = performance.now() - t0;

  const t1 = performance.now();
  try {
    await prometheusRequest(
      target,
      "query",
      new URLSearchParams({ query: "1" }),
      timeouts(),
    );
  } catch (err) {
    const status = err instanceof PrometheusUnavailableError ? err.status : undefined;
    const rejected = status === 401 || status === 403;
    return {
      ok: false,
      message: rejected
        ? `The endpoint refused the ${cfg.auth === "none" ? "unauthenticated request" : "credential"} (${status}).`
        : err instanceof Error
          ? err.message
          : String(err),
      ...(rejected ? { auth: { mode: cfg.auth, accepted: false } } : {}),
    };
  }
  const queryMs = performance.now() - t1;

  const build = (await prometheusRequest(
    target,
    "status/buildinfo",
    new URLSearchParams(),
    {
      ...timeouts(),
      method: "GET",
    },
  ).catch(() => null)) as Record<string, unknown> | null;

  const [surface, metrics] = await Promise.all([
    writeSurface(target),
    metricReachability(
      target,
      cfg.metrics.map((m) => m.name),
    ),
  ]);
  return {
    ok: true,
    message:
      ready?.ok === false
        ? "Connected, though /-/ready did not answer ready."
        : "Connected.",
    latency: { connectMs, queryMs },
    endpoint: productOf(build),
    auth: { mode: cfg.auth, accepted: true },
    writeSurface: surface,
    metrics,
  };
}
