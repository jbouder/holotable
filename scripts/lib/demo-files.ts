import { rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { SPEC_VERSION } from "@/lib/ir";
import type { DemoLinkTargets } from "./demo-dashboards";

/**
 * The files demo (#574): a small directory of Parquet, CSV and JSON-lines
 * (#596) files the
 * seeder writes under `DUCKDB_SOURCES_DIR`, the DuckDB source it registers
 * over them, and the **Demo files** dashboard that reads them.
 *
 * Kept apart from `scripts/seed.ts`, which connects to a database when it is
 * loaded, so `test/demo-dashboards.test.ts` can hold the spec to the IR and
 * the SQL guard against this catalog. The binding is imported only when the
 * files are written, so loading this module never loads a native module.
 *
 * The files are generated, never committed. Every value is a function of its
 * minute (or day) and DuckDB's `hash()`, so a rewrite gives the past the same
 * values it had, and the seeder can rewrite them every minute to move the
 * live edge forward without a dashboard's history changing under it.
 */

export const DEMO_FILES_SOURCE_ID = "duckdb-demo";
export const DEMO_FILES_SOURCE_NAME = "Demo files";
export const DEMO_FILES_DASHBOARD_TITLE = "Demo files";
/** The directory under `DUCKDB_SOURCES_DIR`, and the source's `path`. */
export const DEMO_FILES_PATH = "demo";

/** How much request history `http_requests.parquet` holds. */
export const DEMO_REQUEST_DAYS = 7;
/** How many days `daily_revenue.parquet` holds, ending yesterday. */
export const DEMO_REVENUE_DAYS = 90;
/** How often the seeder rewrites the files, so the newest minute is recent. */
export const DEMO_FILES_REFRESH_MS = 60_000;

/** The source's allowlist: what Discover tables finds in the directory. */
export const DEMO_FILES_TABLES = [
  {
    name: "http_requests",
    description: "per-request events, the last seven days (http_requests.parquet)",
    timeField: "ts",
    columns: [
      { name: "ts", type: "TIMESTAMP" },
      { name: "service", type: "VARCHAR" },
      { name: "route", type: "VARCHAR" },
      { name: "host", type: "VARCHAR" },
      { name: "status", type: "SMALLINT" },
      { name: "duration_ms", type: "DOUBLE" },
      { name: "bytes", type: "BIGINT" },
    ],
  },
  {
    name: "hosts",
    description: "the host inventory, one row per host (hosts.csv)",
    columns: [
      { name: "host", type: "VARCHAR" },
      { name: "region", type: "VARCHAR" },
      { name: "role", type: "VARCHAR" },
      { name: "cores", type: "BIGINT" },
    ],
  },
  {
    name: "links",
    description:
      "the network's links, one row per link from the device above to the one below, routers to switches to the hosts in hosts.csv (links.csv)",
    columns: [
      { name: "parent", type: "VARCHAR" },
      { name: "child", type: "VARCHAR" },
      {
        name: "tier",
        type: "VARCHAR",
        description: "the child's: router, switch or server",
      },
      { name: "bandwidth_gbps", type: "BIGINT" },
    ],
  },
  {
    name: "deploys",
    description:
      "one JSON object per deploy, the last seven days, with a nested actor (deploys.jsonl)",
    timeField: "ts",
    columns: [
      { name: "ts", type: "TIMESTAMP" },
      { name: "service", type: "VARCHAR" },
      { name: "version", type: "VARCHAR" },
      { name: "ok", type: "BOOLEAN" },
      {
        name: "actor",
        type: 'STRUCT("name" VARCHAR, team VARCHAR)',
        description: "who shipped it: read actor.name or actor.team",
      },
    ],
  },
  {
    name: "daily_revenue",
    description:
      "orders and revenue per region per day, the last 90 days (daily_revenue.parquet)",
    timeField: "day",
    columns: [
      { name: "day", type: "TIMESTAMP", description: "midnight UTC of the day" },
      { name: "region", type: "VARCHAR" },
      { name: "orders", type: "INTEGER" },
      { name: "revenue", type: "DOUBLE", description: "in dollars" },
    ],
  },
];

/** The seeded source's config: a path, never an absolute one, and the allowlist. */
export function demoFilesConfig() {
  return { kind: "duckdb" as const, path: DEMO_FILES_PATH, tables: DEMO_FILES_TABLES };
}

export const DEMO_HOSTS: [string, string, string, number][] = [
  ["host-01", "us-east", "api", 8],
  ["host-02", "us-west", "api", 8],
  ["host-03", "eu-central", "web", 4],
  ["host-04", "us-east", "worker", 16],
];

/**
 * The network under the hosts (#624): two core routers linked to each other,
 * each to both distribution switches, those to three access switches, and
 * the access switches to the hosts of {@link DEMO_HOSTS}, two of them dual-homed.
 * Several parents and a cycle, so not a tree: the graph panel's `dag`.
 */
export const DEMO_LINKS: [string, string, "router" | "switch" | "server", number][] = [
  ["core-1", "core-2", "router", 400],
  ["core-2", "core-1", "router", 400],
  ["core-1", "dist-1", "switch", 100],
  ["core-1", "dist-2", "switch", 100],
  ["core-2", "dist-1", "switch", 100],
  ["core-2", "dist-2", "switch", 100],
  ["dist-1", "access-1", "switch", 40],
  ["dist-1", "access-2", "switch", 40],
  ["dist-2", "access-2", "switch", 40],
  ["dist-2", "access-3", "switch", 40],
  ["access-1", "host-01", "server", 10],
  ["access-1", "host-02", "server", 10],
  ["access-2", "host-02", "server", 10],
  ["access-2", "host-03", "server", 10],
  ["access-3", "host-03", "server", 10],
  ["access-3", "host-04", "server", 10],
];

const MINUTE_US = 60_000_000;
const DAY_MS = 86_400_000;

/** A SQL string literal. Only ever given a path the seeder built. */
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/**
 * The `SELECT` behind each file, as of `now`: the files' whole content, a
 * function of `now` alone.
 */
export function demoFileQueries(now: number): Record<string, string> {
  const toMinute = Math.floor(now / 60_000);
  const fromMinute = toMinute - DEMO_REQUEST_DAYS * 1440;
  const today = Math.floor(now / DAY_MS);
  const hosts = DEMO_HOSTS.map(
    ([host, region, role, cores]) => `('${host}', '${region}', '${role}', ${cores})`,
  ).join(", ");
  return {
    // Three to six requests a minute, busier in the (UTC) afternoon. About
    // one in fifty fails with a 500 and waits on a timeout first; /search is
    // slow.
    "http_requests.parquet": `
      SELECT make_timestamp((m * ${MINUTE_US} + (h % 60000000))::BIGINT) AS ts,
             ['api', 'web', 'worker'][1 + ((h >> 8) % 3)::INTEGER] AS service,
             ['/login', '/checkout', '/search', '/profile', '/health'][1 + ((h >> 16) % 5)::INTEGER] AS route,
             ['host-01', 'host-02', 'host-03', 'host-04'][1 + ((h >> 24) % 4)::INTEGER] AS host,
             (CASE WHEN (h >> 32) % 100 < 2 THEN 500 WHEN (h >> 32) % 100 < 6 THEN 404 ELSE 200 END)::SMALLINT AS status,
             round(20 + pow(((h >> 40) % 1000) / 1000.0, 2) * 180
                   + CASE WHEN route = '/search' THEN 150 + ((h >> 44) % 250) ELSE 0 END
                   + CASE WHEN status = 500 THEN 300 ELSE 0 END, 1)::DOUBLE AS duration_ms,
             (200 + (h >> 48) % 5000)::BIGINT AS bytes
        FROM (SELECT m, k, hash(m * 16 + k) AS h
                FROM range(${fromMinute}, ${toMinute}) r(m), range(0, 8) s(k)
               WHERE k < 3 + floor(3 * (1 + sin(2 * pi() * ((m % 1440) - 600) / 1440.0)) / 2)) t
       ORDER BY ts`,
    "hosts.csv": `SELECT * FROM (VALUES ${hosts}) v(host, region, role, cores) ORDER BY host`,
    "links.csv": `SELECT parent, child, tier, bandwidth_gbps FROM (VALUES ${DEMO_LINKS.map(
      ([parent, child, tier, gbps], i) =>
        `(${i}, '${parent}', '${child}', '${tier}', ${gbps})`,
    ).join(", ")}) v(i, parent, child, tier, bandwidth_gbps) ORDER BY i`,
    // A deploy in about one hour in four, per service; one in ten rolled
    // back. One object per line, the person who shipped it nested.
    "deploys.jsonl": `
      SELECT make_timestamp((hr * 3600 * 1000000 + (h % 3600000000))::BIGINT) AS ts,
             service,
             '1.' || (hr // 24 % 100)::VARCHAR || '.' || (hr % 24)::VARCHAR AS version,
             (h >> 12) % 10 <> 0 AS ok,
             {'name': ['ada', 'grace', 'linus', 'margaret'][1 + ((h >> 20) % 4)::INTEGER],
              'team': ['platform', 'payments', 'search'][1 + ((h >> 28) % 3)::INTEGER]} AS actor
        FROM (SELECT hr, service, hash(hr * 4 + si) AS h
                FROM range(${Math.floor(fromMinute / 60)}, ${Math.floor(toMinute / 60)}) r(hr),
                     (VALUES (0, 'api'), (1, 'web'), (2, 'worker')) s(si, service)) t
       WHERE (h >> 4) % 4 = 0
       ORDER BY ts`,
    // A weekly shape (weekends quieter), a region's size, and some noise.
    "daily_revenue.parquet": `
      SELECT make_timestamp((d * ${DAY_MS * 1000})::BIGINT) AS day,
             region,
             orders,
             round(orders * (38 + (h >> 20) % 2000 / 100.0), 2)::DOUBLE AS revenue
        FROM (SELECT d, region,
                     hash(d * 4 + ri) AS h,
                     (weight * (CASE WHEN (d + 4) % 7 IN (5, 6) THEN 0.7 ELSE 1.0 END)
                       * (0.9 + (hash(d * 4 + ri) % 200) / 1000.0))::INTEGER AS orders
                FROM range(${today - DEMO_REVENUE_DAYS}, ${today}) r(d),
                     (VALUES (0, 'us-east', 900), (1, 'us-west', 600), (2, 'eu-central', 450)) g(ri, region, weight)) t
       ORDER BY day, region`,
  };
}

/**
 * Write the files demo into `<root>/demo/`, as of `now`. Each file is written
 * beside its final name as a hidden `.tmp` (which neither the picker nor a
 * directory source reads) and renamed over it, so an engine reading the
 * directory sees the old file or the new one, never half of one.
 */
export async function writeDemoFiles(root: string, now = Date.now()): Promise<string> {
  const dir = join(root, DEMO_FILES_PATH);
  await mkdir(dir, { recursive: true });
  const { DuckDBInstance } = await import("@duckdb/node-api");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    for (const [file, select] of Object.entries(demoFileQueries(now))) {
      const temporary = join(dir, `.${file}.tmp`);
      const format = file.endsWith(".csv")
        ? "csv, HEADER"
        : file.endsWith(".jsonl")
          ? "json"
          : "parquet";
      await connection.run(
        `COPY (${select}) TO ${literal(temporary)} (FORMAT ${format})`,
      );
      await rename(temporary, join(dir, file));
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  return dir;
}

/** One row per minute of the requests file, the window applied through `minute`. */
const perMinute = (select: string) =>
  `SELECT time_bucket(INTERVAL '1 minute', ts) AS minute, ${select} FROM http_requests GROUP BY minute ORDER BY minute`;

/** One row per day of the revenue file, the window applied through `day`. */
const perDay = (select: string) =>
  `SELECT date_trunc('day', day) AS day, ${select} FROM daily_revenue GROUP BY date_trunc('day', day) ORDER BY day`;

const REGIONS = ["us-east", "us-west", "eu-central"];

/**
 * What the files say: traffic from one file, money from another, joined to a
 * CSV, and deploys from JSON lines with a nested object.
 */
export function demoFilesSpec(targets: DemoLinkTargets) {
  return {
    specVersion: SPEC_VERSION,
    title: DEMO_FILES_DASHBOARD_TITLE,
    timeRange: { from: "now-6h", to: "now" },
    refreshIntervalMs: 60000,
    panels: [
      {
        id: "about",
        title: "About this dashboard",
        viz: "text",
        options: {
          content: [
            "## Files, not a database",
            "",
            "Every panel here reads a file through the **Demo files** DuckDB source: `http_requests.parquet`, `hosts.csv`, `links.csv`, `daily_revenue.parquet` and `deploys.jsonl`, which the seeder writes under `DUCKDB_SOURCES_DIR` and rewrites every minute. The same SQL guard and server-owned window as a database source, run in process.",
          ].join("\n"),
        },
        layout: { x: 0, y: 0, w: 12, h: 3 },
      },
      {
        id: "rpm",
        title: "Requests per minute",
        viz: "stat",
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          timeField: "minute",
          sql: perMinute("count(*) AS requests"),
        },
        format: "number",
        options: { sparkline: true, decimals: 0 },
        layout: { x: 0, y: 3, w: 4, h: 3 },
      },
      {
        id: "error-rate",
        title: "5xx error rate",
        viz: "stat",
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          timeField: "minute",
          sql: perMinute(
            "100.0 * count(*) FILTER (WHERE status >= 500) / count(*) AS error_pct",
          ),
        },
        format: "percent",
        options: {
          sparkline: true,
          decimals: 1,
          thresholds: [
            { value: 0, color: "success" },
            { value: 2, color: "warning" },
            { value: 5, color: "danger" },
          ],
        },
        layout: { x: 4, y: 3, w: 4, h: 3 },
      },
      {
        id: "revenue-yesterday",
        title: "Revenue, latest day",
        description: "All regions, by day over the last 30 days.",
        viz: "stat",
        timeRange: { from: "now-30d", to: "now" },
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          timeField: "day",
          sql: perDay("sum(revenue) AS revenue"),
        },
        format: "number",
        options: { sparkline: true, compact: true },
        layout: { x: 8, y: 3, w: 4, h: 3 },
      },
      {
        id: "traffic",
        title: "Requests per minute, by service",
        viz: "line",
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          timeField: "minute",
          sql: perMinute(
            ["api", "web", "worker"]
              .map((s) => `count(*) FILTER (WHERE service = '${s}') AS ${s}`)
              .join(", "),
          ),
        },
        format: "number",
        options: { legend: "top" },
        layout: { x: 0, y: 6, w: 8, h: 4 },
      },
      {
        id: "requests-by-region",
        title: "Requests by region",
        description:
          "The requests file joined to the host inventory (a CSV), over the whole file.",
        viz: "bar",
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          sql: "SELECT h.region, count(*) AS requests FROM http_requests r JOIN hosts h ON h.host = r.host GROUP BY h.region ORDER BY requests DESC",
        },
        format: "number",
        options: { legend: "none" },
        layout: { x: 8, y: 6, w: 4, h: 4 },
      },
      {
        id: "revenue-daily",
        title: "Daily revenue by region",
        viz: "line",
        timeRange: { from: "now-30d", to: "now" },
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          timeField: "day",
          sql: perDay(
            REGIONS.map(
              (r) => `sum(revenue) FILTER (WHERE region = '${r}') AS "${r}"`,
            ).join(", "),
          ),
        },
        format: "number",
        options: { legend: "top" },
        layout: { x: 0, y: 10, w: 7, h: 4 },
      },
      {
        id: "revenue-by-region",
        title: "Revenue by region",
        description: "Over the whole file: the last 90 days.",
        viz: "table",
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          sql: "SELECT region, sum(orders) AS orders, sum(revenue) AS revenue, sum(revenue) / sum(orders) AS per_order FROM daily_revenue GROUP BY region ORDER BY revenue DESC",
        },
        options: {
          columns: [
            { name: "region", label: "Region" },
            { name: "orders", label: "Orders", compact: true, align: "right" },
            { name: "revenue", label: "Revenue", compact: true, align: "right" },
            { name: "per_order", label: "Per order", decimals: 2, align: "right" },
          ],
        },
        layout: { x: 7, y: 10, w: 5, h: 4 },
      },
      {
        id: "deploys",
        title: "Deploys",
        description:
          "The JSON-lines file (#596): who shipped it is a nested object, read as actor.name and actor.team.",
        viz: "table",
        timeRange: { from: "now-7d", to: "now" },
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          timeField: "ts",
          sql: "SELECT ts, service, version, actor.name AS shipped_by, actor.team AS team, ok FROM deploys ORDER BY ts DESC",
        },
        options: {
          columns: [
            { name: "ts", label: "When" },
            { name: "service", label: "Service" },
            { name: "version", label: "Version" },
            { name: "shipped_by", label: "Shipped by" },
            { name: "team", label: "Team" },
            { name: "ok", label: "Succeeded" },
          ],
        },
        layout: { x: 0, y: 14, w: 12, h: 4 },
      },
      {
        id: "network",
        title: "Network topology",
        description:
          "The links CSV joined to the host inventory (#624): core routers to distribution and access switches to the hosts, two of them dual-homed. An arrow runs from the device above to the one below, as wide as its bandwidth; the dashed one closes the loop between the core routers. A host opens its detail.",
        viz: "graph",
        query: {
          sourceId: DEMO_FILES_SOURCE_ID,
          // `host` is a host's own name, from the inventory; a router or a
          // switch has none, so it offers no link.
          sql: "SELECT l.parent, l.child, l.tier, l.bandwidth_gbps, h.host, h.role FROM links l LEFT JOIN hosts h ON h.host = l.child ORDER BY CASE l.tier WHEN 'router' THEN 0 WHEN 'switch' THEN 1 ELSE 2 END, l.parent, l.child",
        },
        format: "number",
        options: {
          layout: "dag",
          direction: "TB",
          source: "parent",
          target: "child",
          value: "bandwidth_gbps",
          group: "tier",
          symbols: { router: "router", switch: "switch", server: "server" },
          unit: "Gbps",
        },
        links: [
          {
            title: "Open host detail",
            dashboard: targets.hostDetail,
            set: { host: { column: "host" } },
          },
        ],
        layout: { x: 0, y: 18, w: 12, h: 6 },
      },
    ],
  };
}
