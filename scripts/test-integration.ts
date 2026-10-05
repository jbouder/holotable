import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { Client } from "pg";
import {
  appliedMigrations,
  applyMigration,
  ensureMigrationsTable,
  loadMigrations,
  pendingMigrations,
  withAdvisoryLock,
} from "./lib/migrations";

/**
 * `npm run test:integration` (#87): the suites that need a real TimescaleDB.
 *
 * With no `MIGRATE_TEST_DATABASE_URL`, starts one with Testcontainers: the
 * image compose and CI run, initialized by the same `timescaledb/init` scripts
 * (the `metrics` schema, its hypertables, and the read-only role), so what is
 * tested is what `docker compose up` builds. With it set, uses that database
 * instead, which must have been initialized the same way and must be a
 * scratch one: the suites write rows, scratch schemas and a scratch database.
 *
 * Either way the config-store migrations are applied first, exactly as
 * `npm run migrate` applies them, and then every real-server test runs with
 * the database in its environment. Those tests skip themselves when it is
 * absent, which is how `npm test` stays fast and needs no Docker.
 *
 * Without Docker the run is skipped with a message rather than failed, so a
 * laptop without it is not broken; under `CI` it fails instead, because a
 * required check that quietly tests nothing is worse than a red one.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IMAGE = "timescale/timescaledb:2.17.2-pg16";

/**
 * The tests that run against the server: everything under `test/integration/`
 * and the real-server halves of suites whose unit half runs in `npm test`.
 */
const SHARED_SUITES = [
  "test/migrations.test.ts",
  "test/audit.test.ts",
  "test/row-filter.test.ts",
  "test/source-pool.test.ts",
  "test/annotations.test.ts",
  "test/share.test.ts",
  "test/api-tokens.test.ts",
];

function suites(): string[] {
  const own = readdirSync(join(ROOT, "test", "integration"))
    .filter((f) => f.endsWith(".test.ts"))
    .sort()
    .map((f) => `test/integration/${f}`);
  return [...own, ...SHARED_SUITES];
}

/** The read-only role `002_readonly_user.sh` creates, and how to log in as it. */
interface Database {
  url: string;
  metricsUser: string;
  metricsPassword: string;
  stop: () => Promise<void>;
}

/**
 * Testcontainers' answer when no strategy (`DOCKER_HOST`, the Docker socket,
 * rootless, a named pipe) reaches a runtime. Anything else, a failed pull or
 * an init script that broke, is a real failure and is not skipped.
 */
function isNoRuntime(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /could not find a working container runtime/i.test(message);
}

async function startContainer(): Promise<Database | null> {
  const metricsPassword = randomBytes(12).toString("hex");
  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer(IMAGE)
      .withDatabase("holotable")
      .withUsername("holotable")
      .withPassword("holotable")
      .withEnvironment({
        TS_METRICS_USERNAME: "metrics_ro",
        TS_METRICS_PASSWORD: metricsPassword,
      })
      .withCopyDirectoriesToContainer([
        {
          source: join(ROOT, "timescaledb", "init"),
          target: "/docker-entrypoint-initdb.d",
        },
      ])
      .start();
  } catch (err) {
    if (!isNoRuntime(err)) throw err;
    const message = `no container runtime found (${err instanceof Error ? err.message : err})`;
    if (process.env.CI) {
      throw new Error(`${message}; CI must run the integration suites`);
    }
    console.log(
      `skipping integration tests: ${message}.\n` +
        "Start Docker, or set MIGRATE_TEST_DATABASE_URL to a scratch database initialized by timescaledb/init.",
    );
    return null;
  }
  return {
    url: container.getConnectionUri(),
    metricsUser: "metrics_ro",
    metricsPassword,
    stop: async () => {
      await container.stop();
    },
  };
}

function givenDatabase(url: string): Database {
  return {
    url,
    metricsUser: process.env.INTEGRATION_METRICS_USERNAME ?? "metrics_ro",
    metricsPassword: process.env.INTEGRATION_METRICS_PASSWORD ?? "readonly",
    stop: async () => {},
  };
}

/** Refuse a database `timescaledb/init` has not set up, then migrate it. */
async function prepare(db: Database): Promise<void> {
  const client = new Client({ connectionString: db.url });
  await client.connect();
  try {
    const { rows } = await client.query<{ schema: boolean; role: boolean }>(
      `SELECT EXISTS (SELECT FROM pg_namespace WHERE nspname = 'metrics') AS schema,
              EXISTS (SELECT FROM pg_roles WHERE rolname = $1) AS role`,
      [db.metricsUser],
    );
    if (!rows[0].schema || !rows[0].role) {
      throw new Error(
        `the database has no metrics schema or no "${db.metricsUser}" role; point ` +
          "MIGRATE_TEST_DATABASE_URL at one initialized by timescaledb/init (as the compose " +
          "postgres is), or unset it to start a container",
      );
    }
    await ensureMigrationsTable(client);
    await withAdvisoryLock(client, 60_000, async () => {
      const all = loadMigrations();
      for (const m of pendingMigrations(all, await appliedMigrations(client))) {
        await applyMigration(client, m);
      }
    });
  } finally {
    await client.end();
  }
}

async function main(): Promise<number> {
  const given = process.env.MIGRATE_TEST_DATABASE_URL;
  const db = given ? givenDatabase(given) : await startContainer();
  if (!db) return 0;
  try {
    await prepare(db);
    const run = spawnSync(
      process.execPath,
      ["--test", "--import", "tsx", ...suites(), ...process.argv.slice(2)],
      {
        cwd: ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          LOG_LEVEL: "silent",
          MIGRATE_TEST_DATABASE_URL: db.url,
          // The config store the repository functions and the poller's
          // source lookup read, in the same database.
          DATABASE_URL: db.url,
          INTEGRATION_METRICS_USERNAME: db.metricsUser,
          INTEGRATION_METRICS_PASSWORD: db.metricsPassword,
          // Short enough that the timeout test waits seconds, not the
          // shipped twenty; the poller test ticks at the floor.
          QUERY_TIMEOUT_SECONDS: "2",
          MIN_REFRESH_INTERVAL_MS: "1000",
        },
      },
    );
    return run.status ?? 1;
  } finally {
    await db.stop();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
