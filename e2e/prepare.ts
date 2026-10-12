import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  APP_PORT,
  DATABASE_URL,
  DUCKDB_DIR,
  KC_PORT,
  LOKI_PORT,
  LOKI_URL,
  PG_PORT,
  PROM_PORT,
  SCRAPE_TOKEN,
} from "./env";

/**
 * Bring the dependencies up and the schema current, before Playwright starts
 * the seeder and the app (#88). `npm run e2e` runs this first; it is a script
 * rather than Playwright's `globalSetup` because Playwright starts its
 * `webServer`s before `globalSetup`, and both of them need the database.
 *
 * `docker compose up --wait` is idempotent, so a second run against a stack
 * that is already up costs a second. `E2E_SKIP_COMPOSE=1` skips it for a job
 * that started the stack in an earlier step, or for services of your own.
 */
const env = {
  ...process.env,
  E2E_PG_PORT: String(PG_PORT),
  E2E_KC_PORT: String(KC_PORT),
  E2E_PROM_PORT: String(PROM_PORT),
  E2E_LOKI_PORT: String(LOKI_PORT),
  E2E_PORT: String(APP_PORT),
  E2E_SCRAPE_TOKEN: SCRAPE_TOKEN,
};

if (process.env.E2E_SKIP_COMPOSE !== "1") {
  execFileSync("docker", ["compose", "-f", "e2e/compose.yml", "up", "-d", "--wait"], {
    stdio: "inherit",
    env,
  });
}

execFileSync("npx", ["tsx", "scripts/migrate.ts"], {
  stdio: "inherit",
  env: { ...env, DATABASE_URL },
});

/**
 * The files a DuckDB source reads in the suite (#573): `requests/` under
 * `DUCKDB_SOURCES_DIR`, holding `http_requests.parquet`, one row a minute
 * from twelve hours before this run to twelve after, so any window a test
 * opens has rows. Written by the binding itself, so nothing binary is
 * committed; rewritten on every run.
 */
async function writeDuckDbFiles(): Promise<void> {
  const dir = join(DUCKDB_DIR, "requests");
  rmSync(DUCKDB_DIR, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    const start = new Date(Date.now() - 12 * 3_600_000).toISOString();
    await connection.run(
      `COPY (
         SELECT TIMESTAMP '${start.slice(0, 19).replace("T", " ")}' + INTERVAL (i) MINUTE AS ts,
                ['checkout', 'search', 'auth'][1 + i % 3] AS service,
                ['/api/cart', '/api/search', '/api/login', '/health'][1 + i % 4] AS route,
                CASE WHEN i % 17 = 0 THEN 500 ELSE 200 END::SMALLINT AS status,
                (20 + (i * 37) % 180)::DOUBLE AS duration_ms
           FROM range(1440) t(i)
       ) TO '${join(dir, "http_requests.parquet")}' (FORMAT parquet)`,
    );
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

writeDuckDbFiles().catch((err: unknown) => {
  process.exitCode = 1;
  throw err;
});

/*
 * Fill the stack's Loki (#567). It has no shipper: a few JSON lines, shaped
 * like the ones Holotable writes (src/lib/log.ts), are pushed here under the
 * labels the specs discover, so what discovery answers is known in advance.
 * This push is the one write the stack makes to Loki; Holotable only reads.
 * The lines span the last half hour, so a panel over the last hour has rows
 * across it, and every push is idempotent in effect: the same labels and
 * values, whatever ran before.
 */

/** The `app` values pushed, which discovery then answers with (e2e/support/app.ts). */
const LOKI_APPS = ["api", "web", "worker"];
const ROUTES = ["dashboards.get", "query.post", "stream.get"];

async function lokiFetch(path: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(`${LOKI_URL}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
}

/** Ask until `ready` says yes, or give up after `ms` with what it last said. */
async function until(what: string, ms: number, ready: () => Promise<boolean>) {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) throw new Error(`Loki: timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
}

function lokiStreams(now: number) {
  return LOKI_APPS.map((app, a) => {
    const values: [string, string][] = [];
    for (let i = 60; i >= 0; i--) {
      const at = now - i * 30_000 - a * 1_000;
      const route = ROUTES[i % ROUTES.length];
      const error = i % 4 === 0;
      const line = {
        level: error ? "error" : "info",
        time: new Date(at).toISOString(),
        msg: error ? "request.failed" : "request.completed",
        route,
        method: "GET",
        status: error ? 500 : 200,
        durationMs: 20 + ((i * 7) % 90),
      };
      // Nanoseconds, as a string: Loki's push takes the epoch at that precision.
      values.push([`${at}000000`, JSON.stringify(line)]);
    }
    return { stream: { app, env: "e2e" }, values };
  });
}

async function fillLoki() {
  // The ingester reports ready a few seconds after the process is up.
  await until("/ready", 120_000, async () => (await lokiFetch("/ready"))?.ok === true);
  const body = JSON.stringify({ streams: lokiStreams(Date.now()) });
  await until("a push to be accepted", 60_000, async () => {
    const res = await lokiFetch("/loki/api/v1/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return res?.status === 204;
  });
  // And for the labels to be indexed, which is what discovery reads.
  await until("the pushed labels", 60_000, async () => {
    const res = await lokiFetch("/loki/api/v1/label/app/values");
    if (!res?.ok) return false;
    const { data } = (await res.json()) as { data?: string[] };
    return LOKI_APPS.every((app) => data?.includes(app));
  });
}

fillLoki().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
