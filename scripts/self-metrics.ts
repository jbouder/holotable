import { Client } from "pg";
import {
  isCollected,
  parseExposition,
  ROW_COLUMNS,
  rowValues,
  toRow,
} from "@/lib/self-monitoring/exposition";

/**
 * The self-monitoring collector (#54).
 *
 * Scrapes the app's own `GET /api/metrics` and lands one row per series per
 * scrape in `metrics.holotable_self`, which `scripts/seed.ts` registers as an
 * ordinary source. Holotable then reads SQL over its own instruments — source
 * registry, catalog allowlist, SQL guard, server-owned time range, live
 * streaming — with nothing about the path special-cased for the demo.
 *
 * Holotable reads SQL, not PromQL, which is why this exists at all: something
 * has to put the samples in a table. This is deliberately a ~100-line loop
 * rather than Prometheus remote-write into a translating sidecar. Prometheus
 * is still in `docker-compose.yml` under the `metrics` profile for anyone who
 * wants the real scraper and its alerting; the demo does not need it.
 *
 * Writes go through the privileged TimescaleDB connection, the same one the
 * seeder uses, and are read back through the app's read-only `metrics_ro`
 * user.
 */

const DEFAULT_URL = "http://app:3000/api/metrics";
const DEFAULT_INTERVAL_MS = 15_000;

function metricsClient() {
  const connectionString = process.env.TIMESCALEDB_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("TIMESCALEDB_URL or DATABASE_URL is not set");
  return new Client({ connectionString });
}

/**
 * Create the hypertable if it is missing. Fresh containers get it from
 * `timescaledb/init/001_schema.sql`; a dev volume created before this existed
 * will not, and neither will a database someone pointed the collector at.
 */
async function ensureTable(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS metrics.holotable_self (
      ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
      metric    TEXT NOT NULL,
      labels    TEXT NOT NULL DEFAULT '',
      dashboard TEXT,
      source    TEXT,
      workspace TEXT,
      model     TEXT,
      direction TEXT,
      route     TEXT,
      reason    TEXT,
      outcome   TEXT,
      le        DOUBLE PRECISION,
      value     DOUBLE PRECISION NOT NULL
    )`);
  await client.query(
    `SELECT create_hypertable('metrics.holotable_self', by_range('ts'), if_not_exists => TRUE)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS holotable_self_metric_ts_idx
       ON metrics.holotable_self (metric, ts DESC)`,
  );
}

/**
 * Fetch one scrape. `/api/metrics` answers 404 until `METRICS_TOKEN` or
 * `METRICS_ALLOWED_CIDRS` is configured, so that case gets its own message —
 * it is the one misconfiguration that looks exactly like a missing route.
 */
async function scrape(url: string, token: string): Promise<string> {
  const res = await fetch(url, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 404) {
    throw new Error(
      `${url} answered 404: metrics are closed until METRICS_TOKEN or METRICS_ALLOWED_CIDRS is set on the app`,
    );
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.text();
}

/** Insert one scrape's collected samples, all stamped with the same time. */
async function store(client: Client, body: string, scrapedAt: Date): Promise<number> {
  const rows = parseExposition(body).filter(isCollected).map(toRow);
  if (rows.length === 0) return 0;

  // $1 is the shared scrape time; each row's own values follow it.
  const params: unknown[] = [scrapedAt];
  const tuples = rows.map((row) => {
    const values = rowValues(row);
    const placeholders = values.map((_, i) => `$${params.length + i + 1}`);
    params.push(...values);
    return `($1, ${placeholders.join(", ")})`;
  });

  await client.query(
    `INSERT INTO metrics.holotable_self (ts, ${ROW_COLUMNS.join(", ")})
     VALUES ${tuples.join(", ")}`,
    params,
  );
  return rows.length;
}

async function main() {
  const url = process.env.METRICS_URL || DEFAULT_URL;
  const token = process.env.METRICS_TOKEN || "";
  const intervalMs = Number(process.env.SELF_METRICS_INTERVAL_MS || DEFAULT_INTERVAL_MS);

  const client = metricsClient();
  await client.connect();
  await ensureTable(client);
  console.log(`collecting ${url} every ${intervalMs}ms — Ctrl+C to stop`);

  for (;;) {
    try {
      const body = await scrape(url, token);
      const stored = await store(client, body, new Date());
      process.stdout.write(stored > 0 ? "." : "o");
    } catch (err) {
      console.warn("\nscrape failed:", err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
