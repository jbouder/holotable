import { SPEC_VERSION } from "@/lib/ir";

/**
 * The demo dashboards the seeder writes, as plain specs. Kept apart from
 * `scripts/seed.ts`, which opens a database connection when it is loaded, so
 * `test/demo-dashboards.test.ts` can hold every one of them to the IR and the
 * SQL guard against the seeded catalogs.
 *
 * Three dashboards, each answering one question with whichever panel kinds
 * answer it best, and between them every kind there is:
 *
 * - **Demo service health**: is the API serving well? Error rate, latency and
 *   availability first, then where traffic and failures come from, then the
 *   log lines behind them.
 * - **Demo fleet**: which hosts need attention, and why? Status first, then
 *   load over time, then where capacity goes. Every host leads to its detail.
 * - **Demo host detail**: one host up close, the target of the fleet's links.
 *
 * A drilldown link names its target by dashboard id, which exists only once
 * the target is inserted, so the dashboards that link are functions of the
 * ids they link to and the seeder writes the targets first.
 */

/** What the linking dashboards need to know about the ones they link to. */
export interface DemoLinkTargets {
  /** "Demo host detail". */
  hostDetail: string;
}

/**
 * Demo dashboards earlier seeds wrote, folded into the three above. The
 * seeder retires each one it still owns (nobody has saved over it); a
 * dashboard a person has saved is theirs, and stays.
 */
export const RETIRED_DEMO_DASHBOARDS = [
  "Demo infrastructure",
  "Demo fleet status",
  "Demo fleet grid",
  "Demo gateway logs",
  "Demo custom visuals",
] as const;

/** The `host` picker "Demo host detail" filters on. */
const HOST_VARIABLE = {
  name: "host",
  label: "Host",
  type: "query",
  query: {
    sourceId: "ts-system",
    sql: "SELECT DISTINCT host FROM system_metrics ORDER BY host",
  },
} as const;

/** One row per minute, the window applied through `minute`. */
const perMinute = (select: string, from: string, where = "") =>
  `SELECT time_bucket('1 minute', ts) AS minute, ${select} FROM ${from}${where ? ` WHERE ${where}` : ""} GROUP BY minute ORDER BY minute`;

/** Is the API serving well, where do its requests go, and what did it log? */
export function demoSpec() {
  return {
    specVersion: SPEC_VERSION,
    title: "Demo service health",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "about",
        title: "About this dashboard",
        viz: "text",
        options: {
          content: [
            "## Service health",
            "",
            "How the demo API is serving: **error rate**, **latency** and **availability** at the top, where traffic and failures come from below them, and the gateway's own log at the bottom. The SLO is 300 ms: amber means slower than that, red slower than a second.",
          ].join("\n"),
        },
        layout: { x: 0, y: 0, w: 12, h: 3 },
      },
      {
        id: "error-rate",
        title: "5xx error rate",
        viz: "stat",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: perMinute(
            "100.0 * count(*) FILTER (WHERE status >= 500) / count(*) AS error_pct",
            "http_requests",
          ),
        },
        format: "percent",
        options: {
          sparkline: true,
          decimals: 1,
          thresholds: [
            { value: 0, color: "success" },
            { value: 1, color: "warning" },
            { value: 5, color: "danger" },
          ],
        },
        layout: { x: 0, y: 3, w: 3, h: 3 },
      },
      {
        id: "p95",
        title: "p95 latency",
        viz: "stat",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: perMinute(
            "percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95",
            "http_requests",
          ),
        },
        format: "ms",
        options: {
          sparkline: true,
          decimals: 0,
          thresholds: [
            { value: 0, color: "success" },
            { value: 300, color: "warning" },
            { value: 1000, color: "danger" },
          ],
        },
        layout: { x: 3, y: 3, w: 3, h: 3 },
      },
      {
        id: "slow-share",
        title: "Requests over the SLO",
        description: "The share of requests slower than 300 ms.",
        viz: "stat",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: perMinute(
            "100.0 * count(*) FILTER (WHERE duration_ms > 300) / count(*) AS slow_pct",
            "http_requests",
          ),
        },
        format: "percent",
        options: {
          sparkline: true,
          decimals: 1,
          thresholds: [
            { value: 0, color: "success" },
            { value: 10, color: "warning" },
            { value: 25, color: "danger" },
          ],
        },
        layout: { x: 6, y: 3, w: 3, h: 3 },
      },
      {
        id: "availability",
        title: "Availability",
        description: "The share of requests answered without a 5xx.",
        viz: "gauge",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: perMinute(
            "100.0 * count(*) FILTER (WHERE status < 500) / count(*) AS availability",
            "http_requests",
          ),
        },
        format: "percent",
        options: {
          min: 90,
          max: 100,
          decimals: 1,
          thresholds: [
            { value: 0, color: "danger" },
            { value: 95, color: "warning" },
            { value: 99, color: "success" },
          ],
        },
        layout: { x: 9, y: 3, w: 3, h: 3 },
      },
      {
        id: "traffic",
        title: "Requests per minute, by outcome",
        viz: "area",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: perMinute(
            "count(*) FILTER (WHERE status < 400) AS ok, count(*) FILTER (WHERE status >= 400 AND status < 500) AS client_errors, count(*) FILTER (WHERE status >= 500) AS server_errors",
            "http_requests",
          ),
        },
        format: "number",
        options: { stacked: true, legend: "top" },
        layout: { x: 0, y: 6, w: 8, h: 4 },
      },
      {
        id: "route-status",
        title: "Requests by route and status",
        description:
          "Each route, then its status codes: the failures are a thin outer slice.",
        viz: "treemap",
        query: {
          sourceId: "ts-metrics",
          timeField: "period",
          sql: "SELECT time_bucket('5 minutes', ts) AS period, route, status, count(*) AS requests FROM http_requests GROUP BY period, route, status ORDER BY period",
        },
        format: "number",
        options: {
          variant: "sunburst",
          path: ["route", "status"],
          value: "requests",
          compact: true,
        },
        layout: { x: 8, y: 6, w: 4, h: 4 },
      },
      {
        id: "latency-band",
        title: "Latency, p5 to p95, against the SLO",
        viz: "vega",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: perMinute(
            "percentile_cont(0.05) WITHIN GROUP (ORDER BY duration_ms) AS p5, percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95",
            "http_requests",
          ),
        },
        options: {
          spec: {
            data: { name: "rows" },
            // `x` is per layer: the rule, given one, would draw once per row.
            layer: [
              {
                mark: "area",
                encoding: {
                  x: { field: "minute", type: "temporal", title: null },
                  y: { field: "p5", type: "quantitative", title: "ms" },
                  y2: { field: "p95" },
                  color: { value: "palette-0" },
                  opacity: { value: 0.25 },
                },
              },
              {
                mark: { type: "line", tooltip: true },
                encoding: {
                  x: { field: "minute", type: "temporal", title: null },
                  y: { field: "p50", type: "quantitative" },
                  color: { value: "palette-0" },
                },
              },
              {
                mark: { type: "rule", strokeDash: [4, 4] },
                encoding: { y: { datum: 300 }, color: { value: "danger" } },
              },
            ],
          },
        },
        layout: { x: 0, y: 10, w: 6, h: 4 },
      },
      {
        id: "latency-distribution",
        title: "Latency distribution",
        description:
          "Every request in the window by 50 ms bucket, on a log scale so the tail shows. Amber from the 300 ms SLO, red from a second.",
        viz: "histogram",
        query: {
          sourceId: "ts-metrics",
          timeField: "period",
          sql: "SELECT time_bucket('5 minutes', ts) AS period, floor(duration_ms / 50) * 50 AS bucket, count(*) AS requests FROM http_requests GROUP BY period, bucket ORDER BY period, bucket",
        },
        format: "ms",
        options: {
          bucket: "bucket",
          count: "requests",
          decimals: 0,
          log: true,
          thresholds: [
            { value: 0, color: "success" },
            { value: 300, color: "warning" },
            { value: 1000, color: "danger" },
          ],
        },
        layout: { x: 6, y: 10, w: 6, h: 4 },
      },
      {
        id: "slowest-routes",
        title: "Slowest routes",
        description: "Over all retained requests, not only the window.",
        viz: "table",
        query: {
          sourceId: "ts-metrics",
          sql: "SELECT route, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms, count(*) AS requests, 100.0 * count(*) FILTER (WHERE status >= 500) / count(*) AS error_pct FROM http_requests GROUP BY route ORDER BY p95_ms DESC",
        },
        options: {
          columns: [
            { name: "route", label: "Route" },
            { name: "p95_ms", label: "p95", format: "ms", decimals: 0, align: "right" },
            { name: "requests", label: "Requests", compact: true, align: "right" },
            {
              name: "error_pct",
              label: "5xx",
              format: "percent",
              decimals: 1,
              align: "right",
            },
          ],
        },
        layout: { x: 0, y: 14, w: 5, h: 4 },
      },
      {
        id: "errors-by-route",
        title: "Server errors by route",
        description: "Over all retained requests, not only the window.",
        viz: "bar",
        query: {
          sourceId: "ts-metrics",
          sql: "SELECT route, count(*) FILTER (WHERE status >= 500) AS server_errors FROM http_requests GROUP BY route ORDER BY server_errors DESC",
        },
        format: "number",
        options: { legend: "none", thresholds: [{ value: 0, color: "danger" }] },
        layout: { x: 5, y: 14, w: 4, h: 4 },
      },
      {
        id: "by-service",
        title: "Requests by service",
        description: "Over all retained requests, not only the window.",
        viz: "pie",
        query: {
          sourceId: "ts-metrics",
          sql: "SELECT service, count(*) AS requests FROM http_requests GROUP BY service ORDER BY requests DESC",
        },
        format: "number",
        options: { legend: "bottom", compact: true },
        layout: { x: 9, y: 14, w: 3, h: 4 },
      },
      {
        id: "recent-problems",
        title: "Recent errors and warnings",
        description:
          "The gateway's newest error and warning lines; expand one for its request id.",
        viz: "logs",
        query: {
          sourceId: "ts-logs",
          timeField: "ts",
          sql: "SELECT ts, level, message, host, route, request_id FROM app_logs WHERE level IN ('error', 'warn') ORDER BY ts DESC LIMIT 200",
        },
        options: { message: "message", level: "level" },
        layout: { x: 0, y: 18, w: 12, h: 5 },
      },
    ],
  };
}

/** Which hosts need attention, and why? Every host leads to its detail. */
export function fleetSpec(targets: DemoLinkTargets) {
  const openHost = [
    {
      title: "Open host detail",
      dashboard: targets.hostDetail,
      set: { host: { series: true } },
    },
  ];
  const perHost = (select: string) =>
    `SELECT time_bucket('1 minute', ts) AS minute, host, ${select} FROM system_metrics GROUP BY minute, host ORDER BY minute`;
  return {
    specVersion: SPEC_VERSION,
    title: "Demo fleet",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "about",
        title: "About this dashboard",
        viz: "text",
        options: {
          content: [
            "## Fleet",
            "",
            "Where each demo host stands **now** at the top, how its load has moved below that, and where the capacity goes at the bottom. CPU is **busy** from 70% and **hot** from 85%; disk is a warning from 80%.",
            "",
            "Click a host anywhere (a tile, a bar, a lane or a row) to open its detail.",
          ].join("\n"),
        },
        layout: { x: 0, y: 0, w: 12, h: 3 },
      },
      {
        id: "cpu-now",
        title: "CPU now",
        viz: "status-grid",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perHost("avg(cpu_pct) AS cpu"),
        },
        options: {
          entity: "host",
          value: "cpu",
          thresholds: [
            { value: 0, color: "success" },
            { value: 70, color: "warning" },
            { value: 85, color: "danger" },
          ],
        },
        format: "percent",
        links: openHost,
        layout: { x: 0, y: 3, w: 6, h: 2 },
      },
      {
        id: "disk-now",
        title: "Disk used",
        viz: "status-grid",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perHost("max(disk_pct) AS disk"),
        },
        options: {
          entity: "host",
          value: "disk",
          sort: "value",
          thresholds: [
            { value: 0, color: "success" },
            { value: 80, color: "warning" },
            { value: 90, color: "danger" },
          ],
        },
        format: "percent",
        links: openHost,
        layout: { x: 6, y: 3, w: 6, h: 2 },
      },
      {
        id: "cpu",
        title: "CPU % by host",
        viz: "line",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, avg(cpu_pct) FILTER (WHERE host = 'host-01') AS \"host-01\", avg(cpu_pct) FILTER (WHERE host = 'host-02') AS \"host-02\", avg(cpu_pct) FILTER (WHERE host = 'host-03') AS \"host-03\", avg(cpu_pct) FILTER (WHERE host = 'host-04') AS \"host-04\" FROM system_metrics GROUP BY minute ORDER BY minute",
        },
        format: "percent",
        options: { legend: "top", yAxis: { min: 0, max: 100 } },
        // A line is a host: a click on one opens it (#373).
        links: openHost,
        layout: { x: 0, y: 5, w: 8, h: 4 },
      },
      {
        id: "memory",
        title: "Memory used",
        viz: "gauge",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perHost("avg(mem_pct) AS mem"),
        },
        options: {
          variant: "bar",
          value: "mem",
          min: 0,
          max: 100,
          thresholds: [
            { value: 0, color: "success" },
            { value: 75, color: "warning" },
            { value: 90, color: "danger" },
          ],
        },
        format: "percent",
        links: openHost,
        layout: { x: 8, y: 5, w: 4, h: 4 },
      },
      {
        id: "cpu-heat",
        title: "CPU heat, by host and minute",
        viz: "heatmap",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perHost("avg(cpu_pct) AS cpu"),
        },
        format: "percent",
        // A menu item rather than a click: a cell is a host and a minute.
        links: [{ title: "Open host detail", dashboard: targets.hostDetail }],
        layout: { x: 0, y: 9, w: 12, h: 3 },
      },
      {
        id: "load-state",
        title: "Load state",
        viz: "state-timeline",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perHost(
            "CASE WHEN avg(cpu_pct) >= 85 THEN 'hot' WHEN avg(cpu_pct) >= 70 THEN 'busy' ELSE 'ok' END AS state",
          ),
        },
        options: {
          entity: "host",
          state: "state",
          states: [
            { state: "ok", color: "success" },
            { state: "busy", color: "warning" },
            { state: "hot", color: "danger" },
          ],
        },
        links: openHost,
        layout: { x: 0, y: 12, w: 12, h: 3 },
      },
      {
        id: "network-share",
        title: "Network in, by region and host",
        description: "Bytes received over the window: each region, then its hosts.",
        viz: "treemap",
        query: {
          sourceId: "ts-system",
          timeField: "period",
          sql: "SELECT time_bucket('5 minutes', ts) AS period, region, host, sum(net_in_bytes) AS bytes FROM system_metrics GROUP BY period, region, host ORDER BY period",
        },
        format: "bytes",
        options: { path: ["region", "host"], value: "bytes" },
        layout: { x: 0, y: 15, w: 6, h: 4 },
      },
      {
        id: "cpu-vs-memory",
        title: "CPU against memory, every 5 minutes",
        description:
          "One point per host and 5 minutes: the hosts sit in their own bands of CPU.",
        viz: "scatter",
        query: {
          sourceId: "ts-system",
          timeField: "period",
          sql: "SELECT time_bucket('5 minutes', ts) AS period, avg(cpu_pct) AS cpu, avg(mem_pct) AS memory FROM system_metrics GROUP BY period, host ORDER BY period",
        },
        format: "percent",
        layout: { x: 6, y: 15, w: 6, h: 4 },
      },
      {
        id: "cpu-ticks",
        title: "Every 5-minute CPU reading, per host",
        description:
          "Where each host usually sits, and how far it strays, against the 85% line.",
        viz: "vega",
        query: {
          sourceId: "ts-system",
          timeField: "period",
          sql: "SELECT time_bucket('5 minutes', ts) AS period, host, avg(cpu_pct) AS cpu FROM system_metrics GROUP BY period, host ORDER BY period",
        },
        options: {
          spec: {
            data: { name: "rows" },
            layer: [
              {
                mark: { type: "tick", opacity: 0.7, tooltip: true },
                encoding: {
                  x: {
                    field: "cpu",
                    type: "quantitative",
                    title: "CPU %",
                    scale: { domain: [0, 100] },
                  },
                  y: { field: "host", type: "nominal", title: null },
                  color: { value: "info" },
                },
              },
              {
                mark: "rule",
                encoding: { x: { datum: 85 }, color: { value: "danger" } },
              },
            ],
          },
        },
        layout: { x: 0, y: 19, w: 6, h: 4 },
      },
      {
        id: "hosts",
        title: "Hosts",
        description: "Over all retained readings, not only the window.",
        viz: "table",
        query: {
          sourceId: "ts-system",
          sql: "SELECT host, region, avg(cpu_pct) AS cpu, avg(mem_pct) AS memory, max(disk_pct) AS disk FROM system_metrics GROUP BY host, region ORDER BY host",
        },
        options: {
          columns: [
            { name: "host", label: "Host" },
            { name: "region", label: "Region" },
            { name: "cpu", label: "CPU", format: "percent", decimals: 1, align: "right" },
            {
              name: "memory",
              label: "Memory",
              format: "percent",
              decimals: 1,
              align: "right",
            },
            {
              name: "disk",
              label: "Disk",
              format: "percent",
              decimals: 1,
              align: "right",
            },
          ],
        },
        links: [
          {
            title: "Open host detail",
            dashboard: targets.hostDetail,
            set: { host: { column: "host" } },
          },
        ],
        layout: { x: 6, y: 19, w: 6, h: 4 },
      },
    ],
  };
}

/**
 * One host up close, the target of the fleet's links. Its `host` picker is
 * what a link sets on arrival, and its own host table switches it in place.
 */
export function hostDetailSpec() {
  return {
    specVersion: SPEC_VERSION,
    title: "Demo host detail",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    variables: [HOST_VARIABLE],
    panels: [
      {
        id: "cpu-mem",
        title: "CPU and memory %",
        viz: "line",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perMinute(
            "avg(cpu_pct) AS cpu, avg(mem_pct) AS mem",
            "system_metrics",
            "host = :host",
          ),
        },
        format: "percent",
        layout: { x: 0, y: 0, w: 8, h: 3 },
      },
      {
        id: "disk",
        title: "Disk used",
        viz: "gauge",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perMinute("max(disk_pct) AS disk", "system_metrics", "host = :host"),
        },
        options: {
          min: 0,
          max: 100,
          thresholds: [
            { value: 0, color: "success" },
            { value: 80, color: "warning" },
            { value: 90, color: "danger" },
          ],
        },
        format: "percent",
        layout: { x: 8, y: 0, w: 4, h: 3 },
      },
      {
        id: "network",
        title: "Network bytes per minute",
        viz: "area",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: perMinute(
            "sum(net_in_bytes) AS inbound, sum(net_out_bytes) AS outbound",
            "system_metrics",
            "host = :host",
          ),
        },
        format: "bytes",
        layout: { x: 0, y: 3, w: 8, h: 3 },
      },
      {
        id: "hosts",
        title: "All hosts",
        viz: "table",
        query: {
          sourceId: "ts-system",
          sql: "SELECT host, region, round(avg(cpu_pct)::numeric, 1) AS avg_cpu FROM system_metrics GROUP BY host, region ORDER BY host",
        },
        // No dashboard: a click on a row switches this page to that host.
        links: [{ title: "Show this host", set: { host: { column: "host" } } }],
        layout: { x: 8, y: 3, w: 4, h: 3 },
      },
      {
        id: "host-log",
        title: "This host's log",
        viz: "logs",
        query: {
          sourceId: "ts-logs",
          timeField: "ts",
          sql: "SELECT ts, level, message, route, request_id FROM app_logs WHERE host = :host ORDER BY ts DESC LIMIT 200",
        },
        options: { message: "message", level: "level" },
        layout: { x: 0, y: 6, w: 8, h: 5 },
      },
      {
        id: "levels",
        title: "Log lines by level",
        description: "Over all retained lines for this host, not only the window.",
        viz: "donut",
        query: {
          sourceId: "ts-logs",
          sql: "SELECT level, count(*) AS lines FROM app_logs WHERE host = :host GROUP BY level ORDER BY lines DESC",
        },
        format: "number",
        options: { legend: "right", compact: true },
        layout: { x: 8, y: 6, w: 4, h: 5 },
      },
    ],
  };
}
