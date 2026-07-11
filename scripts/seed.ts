import { Client } from "pg";

/**
 * Looping seeder.
 *
 * 1. (once) ensures a demo workspace source + dashboard exist in Postgres so the
 *    app has something to show.
 * 2. (loop) continuously inserts synthetic http_requests rows into TimescaleDB
 *    so the live dashboard streams fresh data.
 *
 * Uses the privileged TimescaleDB connection for inserts — distinct
 * from the app's read-only query user.
 */

const SERVICES = ["api", "web", "worker"];
const ROUTES = ["/login", "/checkout", "/search", "/profile", "/health"];

const HOSTS = ["host-01", "host-02", "host-03", "host-04"];
const REGIONS = ["us-east", "us-west", "eu-central"];

function metricsClient() {
  const connectionString = process.env.TIMESCALEDB_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("TIMESCALEDB_URL or DATABASE_URL is not set");
  return new Client({ connectionString });
}

async function ensureDemo() {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.SEED_DEMO === "false") return;
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    const config = {
      host: process.env.TS_METRICS_HOST || "localhost",
      port: Number(process.env.TS_METRICS_PORT || 5432),
      database: process.env.POSTGRES_DB || "holotable",
      schema: "metrics",
      ssl: false,
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
    };
    await pg.query(
      `INSERT INTO sources (id, workspace_id, name, kind, config, secret_ref, created_by)
       VALUES ('ts-metrics', 'demo', 'Demo TimescaleDB metrics', 'timescaledb', $1, 'TS_METRICS', 'seed')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, kind = EXCLUDED.kind, config = EXCLUDED.config,
             secret_ref = EXCLUDED.secret_ref, tombstoned_at = NULL`,
      [JSON.stringify(config)],
    );

    const systemConfig = {
      host: process.env.TS_METRICS_HOST || "localhost",
      port: Number(process.env.TS_METRICS_PORT || 5432),
      database: process.env.POSTGRES_DB || "holotable",
      schema: "metrics",
      ssl: false,
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
    };
    await pg.query(
      `INSERT INTO sources (id, workspace_id, name, kind, config, secret_ref, created_by)
       VALUES ('ts-system', 'demo', 'Demo TimescaleDB system', 'timescaledb', $1, 'TS_METRICS', 'seed')
       ON CONFLICT (id) DO UPDATE
         SET name = EXCLUDED.name, kind = EXCLUDED.kind, config = EXCLUDED.config,
             secret_ref = EXCLUDED.secret_ref, tombstoned_at = NULL`,
      [JSON.stringify(systemConfig)],
    );

    await ensureDashboard(pg, demoSpec());
    await ensureDashboard(pg, systemSpec());
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

async function insertBatch(client: Client) {
  const now = Date.now();
  const rows = Array.from({ length: 50 }, () => {
    const roll = Math.random();
    const status = roll < 0.9 ? 200 : roll < 0.97 ? 404 : 500;
    return {
      ts: new Date(now - Math.floor(Math.random() * 1000)),
      service: SERVICES[Math.floor(Math.random() * SERVICES.length)],
      route: ROUTES[Math.floor(Math.random() * ROUTES.length)],
      status,
      duration_ms: Math.max(1, 40 + Math.random() * 200 + (status >= 500 ? 300 : 0)),
      bytes: Math.floor(200 + Math.random() * 20000),
    };
  });
  const values = rows.flatMap((row) => [
    row.ts,
    row.service,
    row.route,
    row.status,
    row.duration_ms,
    row.bytes,
  ]);
  const placeholders = rows
    .map((_, index) => {
      const first = index * 6 + 1;
      return `($${first}, $${first + 1}, $${first + 2}, $${first + 3}, $${first + 4}, $${first + 5})`;
    })
    .join(", ");
  await client.query(
    `INSERT INTO metrics.http_requests
       (ts, service, route, status, duration_ms, bytes)
     VALUES ${placeholders}`,
    values,
  );
}

async function insertSystemBatch(client: Client) {
  const now = Date.now();
  // One reading per host so every host stays present in each window.
  const rows = HOSTS.map((host, index) => ({
    ts: new Date(now - Math.floor(Math.random() * 1000)),
    host,
    region: REGIONS[index % REGIONS.length],
    cpu_pct: Math.min(100, Math.max(1, 30 + Math.random() * 50)),
    mem_pct: Math.min(100, Math.max(1, 40 + Math.random() * 40)),
    disk_pct: Math.min(100, Math.max(1, 50 + Math.random() * 30)),
    net_in_bytes: Math.floor(10_000 + Math.random() * 5_000_000),
    net_out_bytes: Math.floor(10_000 + Math.random() * 5_000_000),
  }));
  const values = rows.flatMap((row) => [
    row.ts,
    row.host,
    row.region,
    row.cpu_pct,
    row.mem_pct,
    row.disk_pct,
    row.net_in_bytes,
    row.net_out_bytes,
  ]);
  const placeholders = rows
    .map((_, index) => {
      const first = index * 8 + 1;
      return `($${first}, $${first + 1}, $${first + 2}, $${first + 3}, $${first + 4}, $${first + 5}, $${first + 6}, $${first + 7})`;
    })
    .join(", ");
  await client.query(
    `INSERT INTO metrics.system_metrics
       (ts, host, region, cpu_pct, mem_pct, disk_pct, net_in_bytes, net_out_bytes)
     VALUES ${placeholders}`,
    values,
  );
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
  await ensureDemo().catch((e) => console.warn("demo seed skipped:", e.message));

  const intervalMs = Number(process.env.SEED_INTERVAL_MS || 2000);
  const client = metricsClient();
  await client.connect();
  await ensureMetricsTables(client).catch((e) =>
    console.warn("ensure metrics tables skipped:", e.message),
  );
  console.log(`seeding metrics every ${intervalMs}ms — Ctrl+C to stop`);
  for (;;) {
    try {
      await insertBatch(client);
      await insertSystemBatch(client);
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
