import type { Dashboard } from "@/lib/ir";
import { parseDashboard } from "@/lib/ir";
import type { CatalogTable, SourceConfig, SourceConnection } from "@/lib/registry";

/**
 * The self-monitoring demo (#54): Holotable watching itself.
 *
 * `docker compose up` scrapes the app's own `/api/metrics` into a TimescaleDB
 * hypertable and registers it as an ordinary source, so the shipped demo
 * exercises the real path end to end — source registry, catalog allowlist, SQL
 * guard, server-owned time range, guarded execution, live streaming — against
 * data the app produced itself rather than against synthetic rows.
 *
 * Both halves live here because they are one contract: the panels below are
 * written against {@link SELF_METRICS_TABLE}'s columns and against the metric
 * families `exposition.ts` collects, and `test/self-monitoring.test.ts` holds
 * all three together.
 *
 * The spec is committed rather than generated so it doubles as an IR snapshot:
 * a change to the IR that would break a real stored dashboard fails the test
 * here first.
 */

/** The source id the seeder registers this under. */
export const SELF_SOURCE_ID = "holotable-self";
/** The dashboard's title, which is also how the seeder recognises it. */
export const SELF_DASHBOARD_TITLE = "Holotable self-monitoring";
/** The hypertable the collector writes and the panels read. */
export const SELF_METRICS_TABLE = "holotable_self";

/**
 * The catalog allowlist for the self source: one table, spelled the way the
 * collector creates it. The descriptions are prompt material — this source is
 * as generatable-against as any other, so they say what a column means rather
 * than restating its type.
 */
export function selfMonitoringTables(): CatalogTable[] {
  return [
    {
      name: SELF_METRICS_TABLE,
      description:
        "Holotable's own Prometheus instruments, one row per series per scrape. Counters and histogram buckets are cumulative since the process started, so a rate is the difference across a time bucket.",
      timeField: "ts",
      columns: [
        {
          name: "ts",
          type: "timestamp with time zone",
          description: "When the scrape happened",
        },
        {
          name: "metric",
          type: "text",
          description:
            "Metric name as exposed, including any _bucket/_sum/_count suffix, e.g. holotable_query_duration_seconds_sum",
        },
        {
          name: "labels",
          type: "text",
          description:
            "The full label set, canonically serialized, so series stay distinguishable",
        },
        {
          name: "dashboard",
          type: "text",
          description: "Dashboard id label, when the metric has one",
        },
        {
          name: "source",
          type: "text",
          description: "Source id label, when the metric has one",
        },
        {
          name: "workspace",
          type: "text",
          description: "Workspace label, when the metric has one",
        },
        {
          name: "model",
          type: "text",
          description: "Model id label on the LLM counters",
        },
        {
          name: "direction",
          type: "text",
          description: "input or output, on the LLM token counter",
        },
        {
          name: "route",
          type: "text",
          description: "API route label on the LLM request counter",
        },
        {
          name: "reason",
          type: "text",
          description: "Why the SQL guard refused a statement",
        },
        {
          name: "outcome",
          type: "text",
          description: "How the measured operation ended",
        },
        {
          name: "le",
          type: "double precision",
          description:
            "Histogram bucket upper bound. NULL for the +Inf bucket and for non-buckets",
        },
        { name: "value", type: "double precision", description: "The sample value" },
      ],
    },
  ];
}

/** The full source config, given wherever the collector's database lives. */
export function selfMonitoringConfig(connection: SourceConnection): SourceConfig {
  return { ...connection, tables: selfMonitoringTables() };
}

/**
 * Every metric family the panels below read. Asserted against
 * `COLLECTED_FAMILIES` so a panel cannot be written against a metric the
 * collector throws away.
 */
export const PANEL_METRIC_FAMILIES: readonly string[] = [
  "holotable_poller_tick_duration_seconds",
  "holotable_query_duration_seconds",
  "holotable_sse_subscribers",
  "holotable_pollers_active",
  "holotable_llm_tokens_total",
  "holotable_sql_validation_rejections_total",
  "holotable_process_resident_memory_bytes",
];

/**
 * Two shapes recur in the SQL below, and both exist because the samples are
 * cumulative *per series*:
 *
 *   1. sum across the series of one metric at each `ts`, then
 *   2. take `max - min` inside a time bucket to turn a counter into a rate.
 *
 * Doing (2) before (1) would subtract one series' counter from another's.
 */
function spec(): unknown {
  return {
    title: SELF_DASHBOARD_TITLE,
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels: [
      {
        id: "tick-p95",
        title: "Poller tick p95 (s)",
        description:
          "95th percentile wall time of a dashboard poller tick, read off the histogram buckets: the smallest bucket bound whose share of this minute's ticks has reached 95%.",
        viz: "line",
        format: "number",
        query: {
          sourceId: SELF_SOURCE_ID,
          timeField: "minute",
          sql: `WITH scraped AS (
  SELECT ts, le, sum(value) AS cumulative
  FROM holotable_self
  WHERE metric = 'holotable_poller_tick_duration_seconds_bucket' AND le IS NOT NULL
  GROUP BY ts, le
), buckets AS (
  SELECT time_bucket('1 minute', ts) AS minute, le, max(cumulative) - min(cumulative) AS hits
  FROM scraped
  GROUP BY minute, le
), counted AS (
  SELECT ts, sum(value) AS cumulative
  FROM holotable_self
  WHERE metric = 'holotable_poller_tick_duration_seconds_count'
  GROUP BY ts
), totals AS (
  SELECT time_bucket('1 minute', ts) AS minute, max(cumulative) - min(cumulative) AS ticks
  FROM counted
  GROUP BY minute
)
SELECT buckets.minute, min(buckets.le) AS p95_seconds
FROM buckets JOIN totals ON totals.minute = buckets.minute
WHERE totals.ticks > 0 AND buckets.hits >= 0.95 * totals.ticks
GROUP BY buckets.minute
ORDER BY buckets.minute`,
        },
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
      {
        id: "query-latency",
        title: "Query latency by source (ms)",
        description:
          "Mean wall time of one guarded query per minute, per source: the increase in the histogram's summed seconds divided by the increase in its count.",
        viz: "line",
        format: "ms",
        query: {
          sourceId: SELF_SOURCE_ID,
          timeField: "minute",
          sql: `WITH scraped AS (
  SELECT ts, source,
         sum(value) FILTER (WHERE metric = 'holotable_query_duration_seconds_sum') AS seconds,
         sum(value) FILTER (WHERE metric = 'holotable_query_duration_seconds_count') AS queries
  FROM holotable_self
  WHERE metric IN ('holotable_query_duration_seconds_sum', 'holotable_query_duration_seconds_count')
  GROUP BY ts, source
)
SELECT time_bucket('1 minute', ts) AS minute, source,
       1000.0 * (max(seconds) - min(seconds))
         / NULLIF(max(queries) - min(queries), 0) AS avg_ms
FROM scraped
GROUP BY minute, source
ORDER BY minute`,
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
        query: {
          sourceId: SELF_SOURCE_ID,
          timeField: "minute",
          sql: `SELECT time_bucket('1 minute', ts) AS minute, max(value) AS resident_bytes
FROM holotable_self
WHERE metric = 'holotable_process_resident_memory_bytes'
GROUP BY minute
ORDER BY minute`,
        },
        layout: { x: 0, y: 3, w: 6, h: 3 },
      },
      {
        id: "sse-subscribers",
        title: "Live viewers",
        description:
          "Browsers attached to a dashboard's event stream, summed across dashboards.",
        viz: "line",
        format: "number",
        query: {
          sourceId: SELF_SOURCE_ID,
          timeField: "minute",
          sql: `WITH scraped AS (
  SELECT ts, sum(value) AS subscribers
  FROM holotable_self
  WHERE metric = 'holotable_sse_subscribers'
  GROUP BY ts
)
SELECT time_bucket('1 minute', ts) AS minute, max(subscribers) AS subscribers
FROM scraped
GROUP BY minute
ORDER BY minute`,
        },
        layout: { x: 6, y: 3, w: 3, h: 3 },
      },
      {
        id: "pollers-active",
        title: "Active pollers",
        viz: "stat",
        format: "number",
        query: {
          sourceId: SELF_SOURCE_ID,
          timeField: "minute",
          sql: `SELECT time_bucket('1 minute', ts) AS minute, max(value) AS pollers
FROM holotable_self
WHERE metric = 'holotable_pollers_active'
GROUP BY minute
ORDER BY minute`,
        },
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
          sourceId: SELF_SOURCE_ID,
          timeField: "minute",
          sql: `WITH scraped AS (
  SELECT ts, direction, sum(value) AS cumulative
  FROM holotable_self
  WHERE metric = 'holotable_llm_tokens_total'
  GROUP BY ts, direction
)
SELECT time_bucket('5 minutes', ts) AS minute, direction,
       max(cumulative) - min(cumulative) AS tokens
FROM scraped
GROUP BY minute, direction
ORDER BY minute`,
        },
        layout: { x: 0, y: 6, w: 6, h: 3 },
      },
      {
        id: "sql-rejections",
        title: "SQL guard rejections by reason",
        description:
          "Statements the guard refused, over everything the collector still retains. No time field, so the dashboard's range does not narrow it.",
        viz: "table",
        query: {
          sourceId: SELF_SOURCE_ID,
          sql: `WITH scraped AS (
  SELECT ts, reason, sum(value) AS cumulative
  FROM holotable_self
  WHERE metric = 'holotable_sql_validation_rejections_total'
  GROUP BY ts, reason
)
SELECT reason, max(cumulative) - min(cumulative) AS rejections
FROM scraped
GROUP BY reason
ORDER BY rejections DESC`,
        },
        layout: { x: 6, y: 6, w: 6, h: 3 },
      },
    ],
  };
}

/**
 * The committed spec, parsed against the current IR. Anything that would make
 * this throw is a spec the app could not have stored either.
 */
export function selfMonitoringSpec(): Dashboard {
  return parseDashboard(spec());
}
