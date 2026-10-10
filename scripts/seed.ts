import "./lib/env";
import { Client } from "pg";
import { type Dashboard, parseDashboard } from "@/lib/ir";
import {
  SELF_SOURCE_ID,
  selfMonitoringConfig,
  selfMonitoringSpec,
} from "@/lib/self-monitoring/dashboard";
import {
  PROMETHEUS_SELF_SOURCE_ID,
  prometheusSelfConfig,
  prometheusSelfMonitoringSpec,
} from "@/lib/self-monitoring/prometheus";
import {
  type AppLogRow,
  appLogRows,
  backfillChunks,
  backfillStart,
  type HttpRequestRow,
  httpRequestRows,
  parseBackfill,
  type SystemMetricRow,
  systemMetricRows,
} from "./lib/seed-data";
import {
  customVisualsSpec,
  demoSpec,
  fleetGridSpec,
  fleetSpec,
  hostDetailSpec,
  logsSpec,
  systemSpec,
} from "./lib/demo-dashboards";

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
  source: {
    id: string;
    name: string;
    config: unknown;
    /** `timescaledb` unless said; a Prometheus source says so (#390). */
    kind?: string;
    /** The demo databases' credential; `null` for an unauthenticated endpoint. */
    secretRef?: string | null;
  },
) {
  await pg.query(
    `INSERT INTO sources (id, workspace_id, name, kind, config, secret_ref, created_by, catalog_refreshed_at)
     VALUES ($1, 'demo', $2, $4, $3, $5, 'seed', now())
     ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, kind = EXCLUDED.kind, config = EXCLUDED.config,
           secret_ref = EXCLUDED.secret_ref, tombstoned_at = NULL,
           catalog_refreshed_at = now(), catalog_missing_tables = '{}'`,
    [
      source.id,
      source.name,
      JSON.stringify(source.config),
      source.kind ?? "timescaledb",
      source.secretRef === undefined ? "TS_METRICS" : source.secretRef,
    ],
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

    await upsertSource(pg, {
      id: "ts-logs",
      name: "Demo TimescaleDB logs",
      config: {
        ...demoConnection(),
        tables: [
          {
            name: "app_logs",
            description: "gateway log lines, one per event",
            timeField: "ts",
            columns: [
              { name: "ts", type: "timestamp with time zone" },
              { name: "host", type: "text" },
              { name: "level", type: "text", description: "error, warn, info or debug" },
              { name: "route", type: "text" },
              { name: "message", type: "text" },
              { name: "request_id", type: "text" },
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

    // The same instruments through the compose stack's Prometheus (#390),
    // which scrapes /api/metrics itself. Unauthenticated on the compose
    // network, so no secret_ref; the app reaches it only because
    // SOURCE_URL_ALLOWLIST names its host. Only where there is a Prometheus
    // to ask: compose and `.env.example` set PROMETHEUS_SELF_URL, and the
    // quick-start image, which has none, does not.
    const promUrl = process.env.PROMETHEUS_SELF_URL;
    if (promUrl) {
      const promConfig = prometheusSelfConfig(promUrl);
      await upsertSource(pg, {
        id: PROMETHEUS_SELF_SOURCE_ID,
        name: "Holotable self-monitoring (Prometheus)",
        kind: promConfig.kind,
        config: promConfig,
        secretRef: null,
      });
    }

    await ensureDashboard(pg, demoSpec());
    // Link targets first: a link names its target by id (#371).
    const targets = { hostDetail: await ensureDashboard(pg, hostDetailSpec()) };
    await ensureDashboard(pg, systemSpec(targets));
    await ensureDashboard(pg, fleetSpec(targets));
    await ensureDashboard(pg, fleetGridSpec(targets));
    await ensureDashboard(pg, logsSpec());
    await ensureDashboard(pg, customVisualsSpec());
    await ensureDashboard(pg, selfMonitoringSpec());
    if (promUrl) await ensureDashboard(pg, prometheusSelfMonitoringSpec());
  } finally {
    await pg.end();
  }
}

/**
 * Insert a demo dashboard (and its initial version) if one with that title
 * doesn't exist, and return its id. Validated first, so a seeded row is a
 * current-version spec like any the app writes.
 *
 * A dashboard the seeder wrote and nobody has saved since (its current version
 * is the seed's) is brought up to the spec here with a new version, so an
 * install seeded before a demo change, such as the drilldown links, picks it
 * up on its next start. Once a person saves one, it is theirs and left alone.
 */
async function ensureDashboard(pg: Client, input: unknown): Promise<string> {
  const spec: Dashboard = parseDashboard(input);
  const json = JSON.stringify(spec);
  const existing = await pg.query<{
    id: string;
    latest: number | null;
    created_by: string | null;
    same: boolean | null;
  }>(
    `SELECT d.id, v.created_by, v.spec = $2::jsonb AS same,
            (SELECT max(version) FROM dashboard_versions WHERE dashboard_id = d.id) AS latest
       FROM dashboards d
       LEFT JOIN dashboard_versions v ON v.id = d.current_version_id
      WHERE d.workspace_id = 'demo' AND d.title = $1 AND d.deleted_at IS NULL
      ORDER BY d.created_at
      LIMIT 1`,
    [spec.title, json],
  );
  const found = existing.rows[0];
  if (found) {
    if (found.created_by === "seed" && found.same === false && found.latest !== null) {
      await writeVersion(
        pg,
        found.id,
        found.latest + 1,
        json,
        "Updated by the demo seeder",
      );
      console.log(`updated demo dashboard ${found.id} (${spec.title})`);
    }
    return found.id;
  }
  const d = await pg.query<{ id: string }>(
    `INSERT INTO dashboards (workspace_id, title, created_by) VALUES ('demo', $1, 'seed') RETURNING id`,
    [spec.title],
  );
  const dashboardId = d.rows[0].id;
  await writeVersion(pg, dashboardId, 1, json, null);
  console.log(`seeded demo dashboard ${dashboardId} (${spec.title})`);
  return dashboardId;
}

/** Append a seed-authored version and make it the dashboard's current one. */
async function writeVersion(
  pg: Client,
  dashboardId: string,
  version: number,
  spec: string,
  note: string | null,
) {
  const v = await pg.query<{ id: string }>(
    `INSERT INTO dashboard_versions (dashboard_id, version, spec, created_by, note)
     VALUES ($1, $2, $3, 'seed', $4) RETURNING id`,
    [dashboardId, version, spec, note],
  );
  await pg.query(
    `UPDATE dashboards SET current_version_id = $2, updated_at = now() WHERE id = $1`,
    [dashboardId, v.rows[0].id],
  );
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
const LOG_COLUMNS = ["ts", "host", "level", "route", "message", "request_id"] as const;
const insertLogRows = (client: Client, rows: readonly AppLogRow[]) =>
  insertRows(client, "metrics.app_logs", LOG_COLUMNS, rows);

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
  await backfillTable(client, "metrics.app_logs", appLogRows, insertLogRows, {
    windowMs,
    intervalMs,
    now,
  });
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
  await client.query(`
    CREATE TABLE IF NOT EXISTS metrics.app_logs (
      ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
      host       TEXT NOT NULL,
      level      TEXT NOT NULL,
      route      TEXT NOT NULL,
      message    TEXT NOT NULL,
      request_id TEXT NOT NULL
    )`);
  await client.query(
    `SELECT create_hypertable('metrics.app_logs', by_range('ts'), if_not_exists => TRUE)`,
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
      await insertLogRows(client, appLogRows(now));
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
