import { SPEC_VERSION } from "@/lib/ir";

/**
 * The demo dashboards the seeder writes, as plain specs. Kept apart from
 * `scripts/seed.ts`, which opens a database connection when it is loaded, so
 * `test/demo-dashboards.test.ts` can hold every one of them to the IR and the
 * SQL guard against the seeded catalogs.
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

export function demoSpec() {
  return {
    specVersion: SPEC_VERSION,
    title: "Demo service health",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "rps",
        title: "Requests / min",
        viz: "line",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS requests FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "number",
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
      {
        id: "latency",
        title: "p95 latency (ms)",
        viz: "line",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95 FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "ms",
        layout: { x: 6, y: 0, w: 6, h: 3 },
      },
      {
        id: "errors",
        title: "Errors (5xx) total",
        viz: "stat",
        query: {
          sourceId: "ts-metrics",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) FILTER (WHERE status >= 500) AS errors FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "number",
        layout: { x: 0, y: 3, w: 3, h: 2 },
      },
      {
        id: "by-route",
        title: "Requests by route",
        viz: "table",
        query: {
          sourceId: "ts-metrics",
          sql: "SELECT route, count(*) AS requests FROM http_requests GROUP BY route ORDER BY requests DESC",
        },
        layout: { x: 3, y: 3, w: 9, h: 2 },
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
        layout: { x: 0, y: 5, w: 8, h: 4 },
      },
      {
        id: "error-latency-distribution",
        title: "5xx latency distribution",
        description: "The same, for failed requests only: they wait on a timeout first.",
        viz: "histogram",
        query: {
          sourceId: "ts-metrics",
          timeField: "period",
          sql: "SELECT time_bucket('5 minutes', ts) AS period, floor(duration_ms / 100) * 100 AS bucket, count(*) AS requests FROM http_requests WHERE status >= 500 GROUP BY period, bucket ORDER BY period, bucket",
        },
        format: "ms",
        options: { bucket: "bucket", count: "requests", decimals: 0 },
        layout: { x: 8, y: 5, w: 4, h: 4 },
      },
    ],
  };
}

export function systemSpec(targets: DemoLinkTargets) {
  return {
    specVersion: SPEC_VERSION,
    title: "Demo infrastructure",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "cpu",
        title: "Avg CPU % by host",
        viz: "line",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, host, avg(cpu_pct) AS cpu FROM system_metrics GROUP BY minute, host ORDER BY minute",
        },
        format: "percent",
        layout: { x: 0, y: 0, w: 6, h: 3 },
        // A link with no datum pick: an item in the panel's menu (#372).
        links: [{ title: "Open host detail", dashboard: targets.hostDetail }],
      },
      {
        id: "mem",
        title: "Avg memory % by host",
        viz: "line",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, host, avg(mem_pct) AS mem FROM system_metrics GROUP BY minute, host ORDER BY minute",
        },
        format: "percent",
        layout: { x: 6, y: 0, w: 6, h: 3 },
      },
      {
        id: "disk",
        title: "Max disk % used",
        viz: "stat",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, max(disk_pct) AS disk FROM system_metrics GROUP BY minute ORDER BY minute",
        },
        format: "percent",
        layout: { x: 0, y: 3, w: 3, h: 2 },
      },
      {
        id: "by-region",
        title: "Avg CPU by region",
        viz: "table",
        query: {
          sourceId: "ts-system",
          sql: "SELECT region, round(avg(cpu_pct)::numeric, 1) AS avg_cpu FROM system_metrics GROUP BY region ORDER BY avg_cpu DESC",
        },
        layout: { x: 3, y: 3, w: 9, h: 2 },
      },
    ],
  };
}

/**
 * The newer panel kinds on the same host metrics: a text header, gauges
 * (#200), and a state timeline (#201) whose states are derived in SQL. A
 * dashboard of its own rather than panels added to "Demo infrastructure",
 * because `ensureDashboard` only inserts a title that is missing: an install
 * seeded before these kinds existed gets this one on its next seed.
 */
export function fleetSpec(targets: DemoLinkTargets) {
  const perHostMinute =
    "SELECT time_bucket('1 minute', ts) AS minute, host, avg(cpu_pct) AS cpu FROM system_metrics GROUP BY minute, host ORDER BY minute";
  return {
    specVersion: SPEC_VERSION,
    title: "Demo fleet status",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "about",
        title: "About this dashboard",
        viz: "text",
        options: {
          content: [
            "## Fleet status",
            "",
            "Where each demo host stands **now**, and how its load has moved over the window.",
            "",
            "- **ok** below 70% CPU, **busy** from 70%, **hot** from 85%",
            "- Click a host's bar or one of its lanes to open that host's detail",
            "- The data is the demo seeder's `system_metrics` table, written every few seconds",
          ].join("\n"),
        },
        layout: { x: 0, y: 0, w: 12, h: 3 },
      },
      {
        id: "cpu-now",
        title: "CPU now by host",
        viz: "gauge",
        query: { sourceId: "ts-system", timeField: "minute", sql: perHostMinute },
        options: {
          variant: "bar",
          value: "cpu",
          min: 0,
          max: 100,
          thresholds: [
            { value: 0, color: "success" },
            { value: 70, color: "warning" },
            { value: 85, color: "danger" },
          ],
        },
        format: "percent",
        // The bar is the host: a click opens that host (#373).
        links: [
          {
            title: "Open host detail",
            dashboard: targets.hostDetail,
            set: { host: { series: true } },
          },
        ],
        layout: { x: 0, y: 3, w: 8, h: 3 },
      },
      {
        id: "disk-max",
        title: "Fullest disk",
        viz: "gauge",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, max(disk_pct) AS disk FROM system_metrics GROUP BY minute ORDER BY minute",
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
        layout: { x: 8, y: 3, w: 4, h: 3 },
      },
      {
        id: "load-state",
        title: "Host load state",
        viz: "state-timeline",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, host, CASE WHEN avg(cpu_pct) >= 85 THEN 'hot' WHEN avg(cpu_pct) >= 70 THEN 'busy' ELSE 'ok' END AS state FROM system_metrics GROUP BY minute, host ORDER BY minute",
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
        // A lane is a host, so a click on any span opens it.
        links: [
          {
            title: "Open host detail",
            dashboard: targets.hostDetail,
            set: { host: { series: true } },
          },
        ],
        layout: { x: 0, y: 6, w: 12, h: 4 },
      },
    ],
  };
}

/**
 * The fleet as tiles (#404): every host's CPU, fullest disk and load state
 * now, one status grid each, and every tile a way into that host's detail.
 * Its own dashboard, like "Demo fleet status", so an install seeded before
 * the kind existed gets it on its next seed.
 */
export function fleetGridSpec(targets: DemoLinkTargets) {
  const openHost = [
    {
      title: "Open host detail",
      dashboard: targets.hostDetail,
      set: { host: { series: true } },
    },
  ];
  return {
    specVersion: SPEC_VERSION,
    title: "Demo fleet grid",
    timeRange: { from: "now-15m", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "about",
        title: "About this dashboard",
        viz: "text",
        options: {
          content: [
            "## Fleet grid",
            "",
            "One tile per demo host, showing its latest minute. CPU and disk are colored by thresholds, load by state.",
            "",
            "Click a tile to open that host's detail.",
          ].join("\n"),
        },
        layout: { x: 0, y: 0, w: 12, h: 2 },
      },
      {
        id: "cpu",
        title: "CPU now",
        viz: "status-grid",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, host, avg(cpu_pct) AS cpu FROM system_metrics GROUP BY minute, host ORDER BY minute",
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
        layout: { x: 0, y: 2, w: 6, h: 2 },
      },
      {
        id: "disk",
        title: "Disk used",
        viz: "status-grid",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, host, max(disk_pct) AS disk FROM system_metrics GROUP BY minute, host ORDER BY minute",
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
        layout: { x: 6, y: 2, w: 6, h: 2 },
      },
      {
        id: "load",
        title: "Load state",
        viz: "status-grid",
        query: {
          sourceId: "ts-system",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, host, CASE WHEN avg(cpu_pct) >= 85 THEN 'hot' WHEN avg(cpu_pct) >= 70 THEN 'busy' ELSE 'ok' END AS state FROM system_metrics GROUP BY minute, host ORDER BY minute",
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
        layout: { x: 0, y: 4, w: 12, h: 2 },
      },
    ],
  };
}

/**
 * The gateway's log (#404): errors per minute, whose time brush
 * narrows the window, over the lines themselves, filtered by level.
 */
export function logsSpec() {
  return {
    specVersion: SPEC_VERSION,
    title: "Demo gateway logs",
    timeRange: { from: "now-15m", to: "now" },
    refreshIntervalMs: 5000,
    variables: [
      {
        name: "level",
        label: "Level",
        type: "enum",
        values: ["error", "warn", "info", "debug"],
        multi: true,
        default: ["error", "warn", "info"],
      },
    ],
    panels: [
      {
        id: "errors",
        title: "Errors per minute",
        description: "Drag across the chart to read the lines from that stretch.",
        viz: "bar",
        query: {
          sourceId: "ts-logs",
          timeField: "minute",
          sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) FILTER (WHERE level = 'error') AS errors FROM app_logs GROUP BY minute ORDER BY minute",
        },
        // Every bar is an error count: one step colors them all.
        options: { legend: "none", thresholds: [{ value: 0, color: "danger" }] },
        layout: { x: 0, y: 0, w: 12, h: 3 },
      },
      {
        id: "lines",
        title: "Gateway log",
        viz: "logs",
        query: {
          sourceId: "ts-logs",
          timeField: "ts",
          sql: "SELECT ts, level, message, host, route, request_id FROM app_logs WHERE level = ANY(:level) ORDER BY ts DESC LIMIT 200",
        },
        options: { message: "message", level: "level" },
        layout: { x: 0, y: 3, w: 12, h: 6 },
      },
    ],
  };
}

/**
 * One host up close, the target of the fleet's and the infrastructure
 * dashboard's links. Its `host` picker is what a link sets on arrival, and its
 * host table filters the page in place with a self link (#373).
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
          sql: "SELECT time_bucket('1 minute', ts) AS minute, avg(cpu_pct) AS cpu, avg(mem_pct) AS mem FROM system_metrics WHERE host = :host GROUP BY minute ORDER BY minute",
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
          sql: "SELECT time_bucket('1 minute', ts) AS minute, max(disk_pct) AS disk FROM system_metrics WHERE host = :host GROUP BY minute ORDER BY minute",
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
          sql: "SELECT time_bucket('1 minute', ts) AS minute, sum(net_in_bytes) AS inbound, sum(net_out_bytes) AS outbound FROM system_metrics WHERE host = :host GROUP BY minute ORDER BY minute",
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
    ],
  };
}
