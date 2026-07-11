import { createClient } from "@clickhouse/client";
import { Client } from "pg";

/**
 * Looping seeder.
 *
 * 1. (once) ensures a demo workspace source + dashboard exist in Postgres so the
 *    app has something to show.
 * 2. (loop) continuously inserts synthetic http_requests rows into ClickHouse
 *    so the live dashboard streams fresh data.
 *
 * Uses a privileged ClickHouse user (CLICKHOUSE_* env) for inserts — distinct
 * from the app's read-only query user.
 */

const SERVICES = ["api", "web", "worker"];
const ROUTES = ["/login", "/checkout", "/search", "/profile", "/health"];

function ch() {
  return createClient({
    url: process.env.CLICKHOUSE_URL || "http://localhost:8123",
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
    database: "metrics",
  });
}

async function ensureDemo() {
  const url = process.env.DATABASE_URL;
  if (!url || process.env.SEED_DEMO === "false") return;
  const pg = new Client({ connectionString: url });
  await pg.connect();
  try {
    const config = {
      protocol: "http",
      host: process.env.CH_METRICS_HOST || "clickhouse",
      port: Number(process.env.CH_METRICS_PORT || 8123),
      database: "metrics",
      tables: [
        {
          name: "http_requests",
          description: "per-request events",
          timeField: "ts",
          columns: [
            { name: "ts", type: "DateTime64(3)" },
            { name: "service", type: "LowCardinality(String)" },
            { name: "route", type: "LowCardinality(String)" },
            { name: "status", type: "UInt16" },
            { name: "duration_ms", type: "Float64" },
            { name: "bytes", type: "UInt64" },
          ],
        },
      ],
    };
    await pg.query(
      `INSERT INTO sources (id, workspace_id, name, kind, config, secret_ref, created_by)
       VALUES ('ch-metrics', 'demo', 'Demo ClickHouse metrics', 'clickhouse', $1, 'CH_METRICS', 'seed')
       ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config, tombstoned_at = NULL`,
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
          sourceId: "ch-metrics",
          timeField: "minute",
          sql: "SELECT toStartOfMinute(ts) AS minute, count() AS requests FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "number",
        layout: { x: 0, y: 0, w: 6, h: 3 },
      },
      {
        id: "latency",
        title: "p95 latency (ms)",
        viz: "line",
        query: {
          sourceId: "ch-metrics",
          timeField: "minute",
          sql: "SELECT toStartOfMinute(ts) AS minute, quantile(0.95)(duration_ms) AS p95 FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "ms",
        layout: { x: 6, y: 0, w: 6, h: 3 },
      },
      {
        id: "errors",
        title: "Errors (5xx) total",
        viz: "stat",
        query: {
          sourceId: "ch-metrics",
          timeField: "minute",
          sql: "SELECT toStartOfMinute(ts) AS minute, countIf(status >= 500) AS errors FROM http_requests GROUP BY minute ORDER BY minute",
        },
        format: "number",
        layout: { x: 0, y: 3, w: 3, h: 2 },
      },
      {
        id: "by-route",
        title: "Requests by route",
        viz: "table",
        query: {
          sourceId: "ch-metrics",
          sql: "SELECT route, count() AS requests FROM http_requests GROUP BY route ORDER BY requests DESC",
        },
        layout: { x: 3, y: 3, w: 9, h: 2 },
      },
    ],
  };
}

async function insertBatch(client: ReturnType<typeof createClient>) {
  const now = Date.now();
  const rows = Array.from({ length: 50 }, () => {
    const roll = Math.random();
    const status = roll < 0.9 ? 200 : roll < 0.97 ? 404 : 500;
    return {
      ts: new Date(now - Math.floor(Math.random() * 1000)).toISOString().replace("T", " ").replace("Z", ""),
      service: SERVICES[Math.floor(Math.random() * SERVICES.length)],
      route: ROUTES[Math.floor(Math.random() * ROUTES.length)],
      status,
      duration_ms: Math.max(1, 40 + Math.random() * 200 + (status >= 500 ? 300 : 0)),
      bytes: Math.floor(200 + Math.random() * 20000),
    };
  });
  await client.insert({ table: "http_requests", values: rows, format: "JSONEachRow" });
}

async function main() {
  await ensureDemo().catch((e) => console.warn("demo seed skipped:", e.message));

  const intervalMs = Number(process.env.SEED_INTERVAL_MS || 2000);
  const client = ch();
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
