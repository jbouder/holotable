import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import {
  APP_PORT,
  DATABASE_URL,
  DUCKDB_DIR,
  KC_PORT,
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
