import { type Dashboard, parseDashboard, SPEC_VERSION } from "@/lib/ir";
import { PrometheusConfig, type PrometheusMetric } from "@/lib/sources/kinds/prometheus";

/**
 * The self-monitoring demo's second half (#390): the same panels as
 * `dashboard.ts`, written in PromQL against the compose stack's Prometheus,
 * which scrapes the app's own `/api/metrics`. The SQL dashboard reads the
 * samples a collector landed in a hypertable; this one asks the scraper. Side
 * by side they show one question answered in each language.
 *
 * `test/self-monitoring.test.ts` holds both specs to the metrics the app
 * exports, the PromQL one by metric name through the real guard.
 */

export const PROMETHEUS_SELF_SOURCE_ID = "prometheus-self";

export const PROMETHEUS_SELF_DASHBOARD_TITLE = "Holotable self-monitoring (Prometheus)";

/** Where the compose stack's Prometheus answers, from inside the network. */
export const PROMETHEUS_SELF_URL = "http://prometheus:9090";

/** The labels Prometheus adds to every scraped series. */
const TARGET = ["instance", "job"];

function histogram(name: string, labels: string[], help: string): PrometheusMetric[] {
  const all = [...labels, ...TARGET].sort();
  return [
    { name: `${name}_bucket`, type: "histogram", help, labels: [...all, "le"].sort() },
    { name: `${name}_count`, type: "counter", help: `${help} (count)`, labels: all },
    { name: `${name}_sum`, type: "counter", help: `${help} (sum)`, labels: all },
  ];
}

function single(
  name: string,
  type: PrometheusMetric["type"],
  labels: string[],
  help: string,
): PrometheusMetric {
  return { name, type, help, labels: [...labels, ...TARGET].sort() };
}

/**
 * The allowlist: `up`, and the `holotable_*` families the panels read or a
 * person exploring the source would reach for first. Labels are the ones
 * `src/lib/metrics.ts` declares, plus the target labels Prometheus adds.
 */
export function prometheusSelfMetrics(): PrometheusMetric[] {
  return [
    {
      name: "up",
      type: "gauge",
      help: "1 if the last scrape of the target succeeded, 0 if it did not.",
      labels: TARGET,
    },
    ...histogram(
      "holotable_poller_tick_duration_seconds",
      ["dashboard"],
      "Wall time of one dashboard poller tick, in seconds.",
    ),
    ...histogram(
      "holotable_query_duration_seconds",
      ["outcome", "source"],
      "Wall time of one guarded query, in seconds.",
    ),
    single(
      "holotable_sse_subscribers",
      "gauge",
      ["dashboard"],
      "Browsers attached to a dashboard's event stream.",
    ),
    single("holotable_pollers_active", "gauge", [], "Dashboard pollers running."),
    single(
      "holotable_llm_tokens_total",
      "counter",
      ["direction", "model", "workspace"],
      "Model tokens billed, by direction.",
    ),
    single(
      "holotable_sql_validation_rejections_total",
      "counter",
      ["reason"],
      "Statements the SQL guard refused, by reason.",
    ),
    single(
      "holotable_promql_validation_rejections_total",
      "counter",
      ["reason"],
      "Expressions the PromQL guard refused, by reason.",
    ),
    // Capacity (#490).
    ...histogram(
      "holotable_pool_wait_seconds",
      ["source"],
      "Time a query waited for a pool connection, in seconds.",
    ),
    single(
      "holotable_pool_in_use",
      "gauge",
      ["source"],
      "Connections checked out of a source's pool.",
    ),
    single(
      "holotable_poller_skips_total",
      "counter",
      ["reason"],
      "Panel executions a poller skipped for a cycle, by why.",
    ),
    single(
      "holotable_sse_bytes_total",
      "counter",
      [],
      "Bytes written to dashboard streams.",
    ),
    single(
      "holotable_sse_drops_total",
      "counter",
      ["reason"],
      "Dashboard streams the server closed, by why.",
    ),
    single(
      "holotable_result_truncations_total",
      "counter",
      ["stage"],
      "Results cut short on the server, by stage.",
    ),
    single("holotable_llm_in_flight", "gauge", ["model"], "Model requests running now."),
    single(
      "holotable_process_resident_memory_bytes",
      "gauge",
      [],
      "Resident memory size of the app process, in bytes.",
    ),
  ];
}

/** The `prometheus-self` source's config: unauthenticated, on the compose network. */
export function prometheusSelfConfig(url = PROMETHEUS_SELF_URL): PrometheusConfig {
  return PrometheusConfig.parse({
    kind: "prometheus",
    url,
    auth: "none",
    metrics: prometheusSelfMetrics(),
  });
}

function spec(): unknown {
  const sourceId = PROMETHEUS_SELF_SOURCE_ID;
  return {
    specVersion: SPEC_VERSION,
    title: PROMETHEUS_SELF_DASHBOARD_TITLE,
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels: [
      {
        id: "tick-p95",
        title: "Poller tick p95 (s)",
        description:
          "95th percentile wall time of a dashboard poller tick, from the histogram's buckets.",
        viz: "line",
        format: "number",
        query: {
          sourceId,
          promql:
            "histogram_quantile(0.95, sum by (le) (rate(holotable_poller_tick_duration_seconds_bucket[5m])))",
        },
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
      {
        id: "query-latency",
        title: "Query latency by source (ms)",
        description:
          "Mean wall time of one guarded query, per source: the rate of the summed seconds over the rate of the count.",
        viz: "line",
        format: "ms",
        query: {
          sourceId,
          promql:
            "1000 * sum by (source) (rate(holotable_query_duration_seconds_sum[5m])) / sum by (source) (rate(holotable_query_duration_seconds_count[5m]))",
        },
        layout: { x: 6, y: 0, w: 6, h: 3 },
      },
      {
        id: "resident-memory",
        title: "Resident memory",
        description:
          "The app process's resident set size, the one series that is live from boot.",
        viz: "area",
        format: "bytes",
        query: { sourceId, promql: "max(holotable_process_resident_memory_bytes)" },
        layout: { x: 0, y: 3, w: 6, h: 3 },
      },
      {
        id: "sse-subscribers",
        title: "Live viewers",
        description:
          "Browsers attached to a dashboard's event stream, summed across dashboards.",
        viz: "line",
        format: "number",
        query: { sourceId, promql: "sum(holotable_sse_subscribers)" },
        layout: { x: 6, y: 3, w: 3, h: 3 },
      },
      {
        id: "pollers-active",
        title: "Active pollers",
        viz: "stat",
        format: "number",
        query: { sourceId, promql: "max(holotable_pollers_active)", instant: true },
        layout: { x: 9, y: 3, w: 3, h: 3 },
      },
      {
        id: "llm-tokens",
        title: "Model tokens per 5 minutes",
        description:
          "Tokens billed by direction. Empty until a generate or chat request runs.",
        viz: "bar",
        format: "number",
        query: {
          sourceId,
          promql: "sum by (direction) (increase(holotable_llm_tokens_total[5m]))",
          minStep: "5m",
        },
        layout: { x: 0, y: 6, w: 6, h: 3 },
      },
      {
        id: "sql-rejections",
        title: "SQL guard rejections by reason, last hour",
        description: "Statements the SQL guard refused in the last hour, by reason.",
        viz: "table",
        query: {
          sourceId,
          promql:
            "sum by (reason) (increase(holotable_sql_validation_rejections_total[1h]))",
          instant: true,
        },
        layout: { x: 6, y: 6, w: 6, h: 3 },
      },
      // Capacity (#490): what runs out first under load.
      {
        id: "pool-wait",
        title: "Pool wait by source (ms)",
        description:
          "Mean time a query waited for a connection, per source. Near zero is healthy; a rising line means MAX_POOL_PER_SOURCE is the limit.",
        viz: "line",
        format: "ms",
        query: {
          sourceId,
          promql:
            "1000 * sum by (source) (rate(holotable_pool_wait_seconds_sum[5m])) / sum by (source) (rate(holotable_pool_wait_seconds_count[5m]))",
        },
        layout: { x: 0, y: 9, w: 6, h: 3 },
      },
      {
        id: "poller-skips",
        title: "Poller skips per 5 minutes",
        description:
          "Panels that waited out a cycle because their source was busy, by why. Zero is healthy.",
        viz: "bar",
        format: "number",
        query: {
          sourceId,
          promql: "sum by (reason) (increase(holotable_poller_skips_total[5m]))",
          minStep: "5m",
        },
        layout: { x: 6, y: 9, w: 6, h: 3 },
      },
      {
        id: "sse-bytes",
        title: "Stream bytes per minute",
        description: "Bytes written to every dashboard stream on the instance.",
        viz: "area",
        format: "bytes",
        query: { sourceId, promql: "60 * sum(rate(holotable_sse_bytes_total[5m]))" },
        layout: { x: 0, y: 12, w: 6, h: 3 },
      },
      {
        id: "capacity-events",
        title: "Drops and truncations",
        description:
          "Streams closed for falling behind, and results cut short by stage. Zero is healthy; a steady count names the limit to raise or the query to narrow.",
        viz: "table",
        query: {
          sourceId,
          promql:
            "sum by (reason, stage) (increase(holotable_sse_drops_total[1h]) or increase(holotable_result_truncations_total[1h]))",
          instant: true,
        },
        layout: { x: 6, y: 12, w: 3, h: 3 },
      },
      {
        id: "llm-in-flight",
        title: "Model requests in flight",
        viz: "stat",
        format: "number",
        query: { sourceId, promql: "sum(holotable_llm_in_flight)", instant: true },
        layout: { x: 9, y: 12, w: 3, h: 3 },
      },
    ],
  };
}

/** The committed spec, parsed against the current IR. */
export function prometheusSelfMonitoringSpec(): Dashboard {
  return parseDashboard(spec());
}
