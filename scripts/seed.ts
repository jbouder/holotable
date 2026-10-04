import "./lib/env";
import { Client } from "pg";
import {
  SELF_SOURCE_ID,
  selfMonitoringConfig,
  selfMonitoringSpec,
} from "@/lib/self-monitoring/dashboard";
import {
  backfillChunks,
  backfillStart,
  type HttpRequestRow,
  httpRequestRows,
  parseBackfill,
  type SystemMetricRow,
  systemMetricRows,
} from "./lib/seed-data";

/**
 * Looping seeder.
 *
 * 1. (once) ensures a demo workspace source + dashboard exist in Postgres so the
 *    app has something to show.
 * 2. (once, with SEED_BACKFILL) inserts the history the loop would have
 *    written across that window, so a fresh database does not start with
 *    empty charts (#252).
 * 3. (loop) continuously inserts synthetic http_requests rows into TimescaleDB
 *    so the live dashboard streams fresh data.
 *
 * Uses the privileged TimescaleDB connection for inserts — distinct
 * from the app's read-only query user.
 */

function metricsClient() {
  const connectionString = process.env.TIMESCALEDB_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("TIMESCALEDB_URL or DATABASE_URL is not set");
  return new Client({ connectionString });
}

/** The connection every demo source shares: the seeder's own database. */
function demoConnection() {
  return {
    host: process.env.TS_METRICS_HOST || "localhost",
    port: Number(process.env.TS_METRICS_PORT || 5432),
    database: process.env.POSTGRES_DB || "holotable",
    schema: "metrics",
    ssl: false,
  };
}

/**
 * Register (or re-register) one demo source.
 *
 * `catalog_refreshed_at` is stamped because #107 gates generation on it: a
 * source that has never been introspected is refused before the model is
 * called, and a seeded catalog written from this file has, in the only sense
 * that matters, just been introspected.
 */
async function upsertSource(
  pg: Client,
  source: { id: string; name: string; config: unknown },
) {
  await pg.query(
    `INSERT INTO sources (id, workspace_id, name, kind, config, secret_ref, created_by, catalog_refreshed_at)
     VALUES ($1, 'demo', $2, 'timescaledb', $3, 'TS_METRICS', 'seed', now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, kind = EXCLUDED.kind, config = EXCLUDED.config,
           secret_ref = EXCLUDED.secret_ref, tombstoned_at = NULL,
           catalog_refreshed_at = now(), catalog_missing_tables = '{}'`,
    [source.id, source.name, JSON.stringify(source.config)],
  );
}

async function ensureDemo() {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.SEED_DEMO === "false") return;
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    await upsertSource(pg, {
      id: "ts-metrics",
      name: "Demo TimescaleDB metrics",
      config: {
        ...demoConnection(),
        tables: [
          {
            name: "http_requests",
            description: "per-request events",
            timeField: "ts",
            columns: [
              { name: "ts", type: "timestamp with time zone" },
              { name: "service", type: "text" },
              { name: "route", type: "text" },
              { name: "status", type: "smallint" },
              { name: "duration_ms", type: "double precision" },
              { name: "bytes", type: "bigint" },
            ],
          },
        ],
      },
    });

    await upsertSource(pg, {
      id: "ts-system",
      name: "Demo TimescaleDB system",
      config: {
        ...demoConnection(),
        tables: [
          {
            name: "system_metrics",
            description: "per-host infrastructure metrics",
            timeField: "ts",
            columns: [
              { name: "ts", type: "timestamp with time zone" },
              { name: "host", type: "text" },
              { name: "region", type: "text" },
              { name: "cpu_pct", type: "double precision" },
              { name: "mem_pct", type: "double precision" },
              { name: "disk_pct", type: "double precision" },
              { name: "net_in_bytes", type: "bigint" },
              { name: "net_out_bytes", type: "bigint" },
            ],
          },
        ],
      },
    });

    // Holotable's own instruments, landed by scripts/self-metrics.ts. Seeded
    // whether or not the collector is running: an empty table is a dashboard
    // with empty panels, while a missing source is a broken one.
    await upsertSource(pg, {
      id: SELF_SOURCE_ID,
      name: "Holotable self-monitoring",
      config: selfMonitoringConfig(demoConnection()),
    });

    await ensureDashboard(pg, demoSpec());
    await ensureDashboard(pg, systemSpec());
    await ensureDashboard(pg, selfMonitoringSpec());
  } finally {
    await pg.end();
  }
}

/** Insert a demo dashboard (and its initial version) if one with that title doesn't exist. */
async function ensureDashboard(pg: Client, spec: { title: string }) {
  const existing = await pg.query(
    "SELECT id FROM dashboards WHERE workspace_id = 'demo' AND title = $1 AND deleted_at IS NULL",
    [spec.title],
  );
  if (existing.rowCount !== 0) return;
  const d = await pg.query(
    `INSERT INTO dashboards (workspace_id, title, created_by) VALUES ('demo', $1, 'seed') RETURNING id`,
    [spec.title],
  );
  const dashboardId = d.rows[0].id;
  const v = await pg.query(
    `INSERT INTO dashboard_versions (dashboard_id, version, spec, created_by)
     VALUES ($1, 1, $2, 'seed') RETURNING id`,
    [dashboardId, JSON.stringify(spec)],
  );
  await pg.query(`UPDATE dashboards SET current_version_id = $2 WHERE id = $1`, [
    dashboardId,
    v.rows[0].id,
  ]);
  console.log(`seeded demo dashboard ${dashboardId} (${spec.title})`);
}

function demoSpec() {
  return {
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
    ],
  };
}

function systemSpec() {
  return {
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

/** One multi-row insert; the caller keeps `rows` within the parameter limit. */
async function insertRows<T>(
  client: Client,
  table: string,
  columns: readonly (keyof T & string)[],
  rows: readonly T[],
) {
  if (rows.length === 0) return;
  const values = rows.flatMap((row) => columns.map((c) => row[c]));
  const placeholders = rows
    .map((_, index) => {
      const first = index * columns.length + 1;
      return `(${columns.map((_, c) => `$${first + c}`).join(", ")})`;
    })
    .join(", ");
  await client.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${placeholders}`,
    values,
  );
}

const HTTP_COLUMNS = [
  "ts",
  "service",
  "route",
  "status",
  "duration_ms",
  "bytes",
] as const;
const SYSTEM_COLUMNS = [
  "ts",
  "host",
  "region",
  "cpu_pct",
  "mem_pct",
  "disk_pct",
  "net_in_bytes",
  "net_out_bytes",
] as const;

const insertHttpRows = (client: Client, rows: readonly HttpRequestRow[]) =>
  insertRows(client, "metrics.http_requests", HTTP_COLUMNS, rows);
const insertSystemRows = (client: Client, rows: readonly SystemMetricRow[]) =>
  insertRows(client, "metrics.system_metrics", SYSTEM_COLUMNS, rows);

/** The newest row's time in a demo table, or null when it is empty. */
async function newestRow(client: Client, table: string): Promise<number | null> {
  const { rows } = await client.query<{ newest: Date | null }>(
    `SELECT max(ts) AS newest FROM ${table}`,
  );
  return rows[0]?.newest ? rows[0].newest.getTime() : null;
}

/**
 * Fill `metrics.http_requests` and `metrics.system_metrics` back across the
 * window, at the live cadence, in chunks of at most 5 000 rows (#252).
 *
 * Each table starts at the window start or just after its newest existing
 * row, whichever is later, so a second start on a mounted volume fills only
 * the gap it was down for and never doubles the history. Then the
 * `http_requests_1m` continuous aggregate is refreshed over what was written,
 * so it is populated now rather than after its policy's first run.
 * `metrics.holotable_self` is never backfilled: real samples from boot are the
 * point of that source.
 */
async function backfill(client: Client, windowMs: number, intervalMs: number) {
  const now = Date.now();
  const httpFrom = await backfillTable(
    client,
    "metrics.http_requests",
    httpRequestRows,
    insertHttpRows,
    { windowMs, intervalMs, now },
  );
  await backfillTable(
    client,
    "metrics.system_metrics",
    systemMetricRows,
    insertSystemRows,
    { windowMs, intervalMs, now },
  );
  if (httpFrom === null) return;
  try {
    await client.query(
      "CALL refresh_continuous_aggregate('metrics.http_requests_1m', $1::timestamptz, now())",
      [new Date(httpFrom)],
    );
    console.log("backfill: refreshed metrics.http_requests_1m");
  } catch (err) {
    // Not fatal: the aggregate's own policy catches up within its schedule.
    console.warn(
      "backfill: aggregate refresh skipped:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Backfill one table; returns where it started, or null when it was current. */
async function backfillTable<T>(
  client: Client,
  table: string,
  make: (at: number, random: () => number, floor: number) => T[],
  insert: (client: Client, rows: readonly T[]) => Promise<void>,
  { windowMs, intervalMs, now }: { windowMs: number; intervalMs: number; now: number },
): Promise<number | null> {
  const from = backfillStart(windowMs, now, await newestRow(client, table));
  if (from >= now - intervalMs) {
    console.log(`backfill ${table}: already current, nothing to fill`);
    return null;
  }
  let written = 0;
  for (const chunk of backfillChunks(make, from, now, intervalMs)) {
    await insert(client, chunk);
    written += chunk.length;
    console.log(`backfill ${table}: ${written} rows`);
  }
  console.log(
    `backfill ${table}: done, ${written} rows from ${new Date(from).toISOString()}`,
  );
  return from;
}

/**
 * Ensure the demo hypertables exist. Fresh containers get these from
 * timescaledb/init, but existing dev volumes won't — so create them here
 * (idempotently) via the privileged metrics connection.
 */
async function ensureMetricsTables(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS metrics.system_metrics (
      ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
      host          TEXT NOT NULL,
      region        TEXT NOT NULL,
      cpu_pct       DOUBLE PRECISION NOT NULL,
      mem_pct       DOUBLE PRECISION NOT NULL,
      disk_pct      DOUBLE PRECISION NOT NULL,
      net_in_bytes  BIGINT NOT NULL,
      net_out_bytes BIGINT NOT NULL
    )`);
  await client.query(
    `SELECT create_hypertable('metrics.system_metrics', by_range('ts'), if_not_exists => TRUE)`,
  );
}

async function main() {
  // Checked before anything is written, so a typo fails fast and loudly
  // instead of quietly seeding no history.
  let backfillMs: number | null;
  try {
    backfillMs = parseBackfill(process.env.SEED_BACKFILL);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }

  await ensureDemo().catch((e) => console.warn("demo seed skipped:", e.message));

  const intervalMs = Number(process.env.SEED_INTERVAL_MS || 2000);
  const client = metricsClient();
  await client.connect();
  await ensureMetricsTables(client).catch((e) =>
    console.warn("ensure metrics tables skipped:", e.message),
  );
  if (backfillMs !== null) {
    await backfill(client, backfillMs, intervalMs).catch((e) =>
      console.warn("backfill failed:", e instanceof Error ? e.message : e),
    );
  }
  console.log(`seeding metrics every ${intervalMs}ms — Ctrl+C to stop`);
  for (;;) {
    try {
      const now = Date.now();
      await insertHttpRows(client, httpRequestRows(now));
      await insertSystemRows(client, systemMetricRows(now));
      process.stdout.write(".");
    } catch (err) {
      console.warn("\ninsert failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
