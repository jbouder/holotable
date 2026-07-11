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

    const existing = await pg.query(
      "SELECT id FROM dashboards WHERE workspace_id = 'demo' AND title = 'Demo service health' AND deleted_at IS NULL",
    );
    if (existing.rowCount === 0) {
      const spec = demoSpec();
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
      console.log(`seeded demo dashboard ${dashboardId}`);
    }
  } finally {
    await pg.end();
  }
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

async function main() {
  await ensureDemo().catch((e) => console.warn("demo seed skipped:", e.message));

  const intervalMs = Number(process.env.SEED_INTERVAL_MS || 2000);
  const client = metricsClient();
  await client.connect();
  console.log(`seeding metrics every ${intervalMs}ms — Ctrl+C to stop`);
  for (;;) {
    try {
      await insertBatch(client);
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
