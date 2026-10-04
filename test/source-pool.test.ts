import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { Pool, PoolConfig } from "pg";
import { config as appConfig } from "@/lib/config";
import { type SourceRecord, SourceConfig } from "@/lib/registry";
import { secretRefEnvVars } from "@/lib/secret-refs";
import { SecretRefError } from "@/lib/secrets/credentials";
import type { ExecutablePlan } from "@/lib/sql/safety";
import { executePlan, QueryExecutionError } from "@/lib/timescaledb/client";
import {
  closeSourcePools,
  connectionFingerprint,
  dropSourcePool,
  POOL_IDLE_TIMEOUT_MS,
  type PoolFactory,
  setPoolFactoryForTests,
  sourcePool,
  sourcePoolCount,
} from "@/lib/timescaledb/pool";

/*
 * Per-source connection pools (#13). The unit half runs on a fake pool that
 * records what it is asked to do; the half at the bottom runs against a real
 * server and proves that a reused connection carries nothing over.
 */

const REF = "HT_POOL";
const WORKSPACE = "ws-pool";
const vars = secretRefEnvVars(REF);

function grant(password = "first") {
  process.env.SOURCE_SECRET_REFS = `${REF}:${WORKSPACE}`;
  process.env[vars.username] = "reader";
  process.env[vars.password] = password;
}

function source(overrides: Partial<SourceConfig> = {}, id = "src-pool"): SourceRecord {
  return {
    id,
    workspaceId: WORKSPACE,
    name: "pool",
    kind: "timescaledb",
    config: SourceConfig.parse({
      host: "db",
      port: 5432,
      database: "metrics",
      schema: "metrics",
      tables: [{ name: "m", columns: [{ name: "v", type: "integer" }] }],
      ...overrides,
    }),
    secretRef: REF,
    catalogRefreshedAt: null,
    catalogMissingTables: [],
    createdBy: "test",
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    tombstonedAt: null,
  };
}

const plan: ExecutablePlan = { sql: "SELECT 1 AS v", params: [] };

/** How the fake statement ends: rows, a server refusal, or a dead socket. */
type Outcome =
  | { kind: "rows" }
  | { kind: "statement-error" }
  | { kind: "socket-error" }
  | { kind: "rollback-fails" };

class FakeClient {
  readonly statements: string[] = [];
  released: boolean | undefined;
  constructor(private readonly outcome: Outcome) {}

  query(arg: string | EventEmitter): Promise<unknown> | EventEmitter {
    if (typeof arg === "string") {
      this.statements.push(arg);
      if (arg === "ROLLBACK" && this.outcome.kind === "rollback-fails") {
        return Promise.reject(new Error("Connection terminated"));
      }
      return Promise.resolve({ rows: [] });
    }
    this.statements.push("<plan>");
    const outcome = this.outcome;
    setImmediate(() => {
      if (outcome.kind === "statement-error") {
        arg.emit(
          "error",
          Object.assign(new Error('column "nope" does not exist'), { code: "42703" }),
        );
      } else if (outcome.kind === "socket-error") {
        arg.emit(
          "error",
          Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
        );
      } else {
        arg.emit("row", { v: 1 });
        arg.emit("end", { fields: [{ name: "v" }] });
      }
    });
    return arg;
  }

  release(destroy?: boolean) {
    this.released = destroy === true;
  }
}

class FakePool extends EventEmitter {
  readonly clients: FakeClient[] = [];
  ended = false;
  outcome: Outcome = { kind: "rows" };
  constructor(readonly options: PoolConfig) {
    super();
  }
  async connect() {
    const client = new FakeClient(this.outcome);
    this.clients.push(client);
    return client;
  }
  async end() {
    this.ended = true;
  }
}

async function withFakePools(body: (built: FakePool[]) => Promise<void>) {
  const built: FakePool[] = [];
  const factory: PoolFactory = (options) => {
    const pool = new FakePool(options);
    built.push(pool);
    return pool as unknown as Pool;
  };
  const previous = setPoolFactoryForTests(factory);
  grant();
  try {
    await body(built);
  } finally {
    setPoolFactoryForTests(previous);
  }
}

test("a source's pool is reused across executions", async () => {
  await withFakePools(async (built) => {
    await executePlan(source(), plan);
    await executePlan(source(), plan);
    await executePlan(source(), plan);
    assert.equal(built.length, 1, "one pool, not one connection per execution");
    assert.equal(built[0].clients.length, 3);
    assert.equal(sourcePoolCount(), 1);
  });
});

test("the pool is capped and its connections time out like a fresh one would", async () => {
  await withFakePools(async () => {
    const options = (sourcePool(source()) as unknown as FakePool).options;
    assert.equal(options.max, appConfig.maxPoolPerSource);
    assert.equal(options.idleTimeoutMillis, POOL_IDLE_TIMEOUT_MS);
    assert.equal(options.statement_timeout, appConfig.queryTimeoutSeconds * 1000);
    assert.equal(
      options.connectionTimeoutMillis,
      (appConfig.queryTimeoutSeconds + 5) * 1000,
    );
    assert.equal(options.user, "reader");
  });
});

test("an execution rolls back before its client goes back to the pool", async () => {
  await withFakePools(async (built) => {
    const result = await executePlan(source(), plan);
    assert.deepEqual(result, { columns: ["v"], rows: [{ v: 1 }] });
    const [client] = built[0].clients;
    assert.deepEqual(client.statements, [
      "BEGIN TRANSACTION READ ONLY",
      'SET LOCAL search_path TO "metrics", public',
      "<plan>",
      "ROLLBACK",
    ]);
    assert.equal(client.released, false, "returned to the pool, not destroyed");
  });
});

test("a refused statement rolls back and keeps its connection", async () => {
  await withFakePools(async (built) => {
    const pool = sourcePool(source()) as unknown as FakePool;
    pool.outcome = { kind: "statement-error" };
    await assert.rejects(executePlan(source(), plan), QueryExecutionError);
    const [client] = built[0].clients;
    assert.equal(client.statements.at(-1), "ROLLBACK");
    assert.equal(client.released, false);
  });
});

test("a connection that failed mid-statement is destroyed, not reused", async () => {
  await withFakePools(async (built) => {
    const pool = sourcePool(source()) as unknown as FakePool;
    pool.outcome = { kind: "socket-error" };
    await assert.rejects(executePlan(source(), plan), /ECONNRESET/);
    assert.equal(built[0].clients[0].released, true);
  });
});

test("a connection whose rollback fails is destroyed, not reused", async () => {
  await withFakePools(async (built) => {
    const pool = sourcePool(source()) as unknown as FakePool;
    pool.outcome = { kind: "rollback-fails" };
    await executePlan(source(), plan);
    assert.equal(built[0].clients[0].released, true);
  });
});

test("changing where or as whom a source connects replaces its pool", async () => {
  await withFakePools(async (built) => {
    const first = sourcePool(source());
    assert.equal(sourcePool(source()), first);

    const moved = sourcePool(source({ host: "db-2" }));
    assert.notEqual(moved, first);
    assert.equal(built[0].ended, true, "the old pool is ended");

    grant("rotated");
    const rotated = sourcePool(source({ host: "db-2" }));
    assert.notEqual(rotated, moved, "a rotated password is a new pool");
    assert.equal(built[1].ended, true);
    assert.equal(sourcePoolCount(), 1);

    // The schema is set per transaction, not per connection: same pool.
    assert.equal(sourcePool(source({ host: "db-2", schema: "other" })), rotated);
  });
});

test("a withdrawn grant refuses the next checkout even with a pool open", async () => {
  await withFakePools(async () => {
    await executePlan(source(), plan);
    process.env.SOURCE_SECRET_REFS = `${REF}:some-other-workspace`;
    await assert.rejects(executePlan(source(), plan), SecretRefError);
  });
});

test("the fingerprint holds no plain copy of the password", () => {
  const fingerprint = connectionFingerprint({
    host: "db",
    port: 5432,
    database: "metrics",
    user: "reader",
    password: "hunter2",
  });
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!fingerprint.includes("hunter2"));
});

test("an idle client's error is handled, not left to end the process", async () => {
  await withFakePools(async () => {
    const pool = sourcePool(source()) as unknown as FakePool;
    assert.equal(pool.listenerCount("error"), 1);
    pool.emit("error", new Error("terminating connection due to administrator command"));
  });
});

test("deleting a source and shutting down close its pools", async () => {
  await withFakePools(async (built) => {
    sourcePool(source({}, "a"));
    sourcePool(source({}, "b"));
    await dropSourcePool("a");
    assert.equal(built[0].ended, true);
    assert.equal(built[1].ended, false);
    await dropSourcePool("never-opened");

    await closeSourcePools();
    assert.equal(built[1].ended, true);
    assert.equal(sourcePoolCount(), 0);
  });
});

/* -------------------------------------------------------------------------- */
/* Against a real server: a reused connection carries nothing over            */
/* -------------------------------------------------------------------------- */

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("pooled connections are reused, capped, and left clean", {
  skip: dbUrl ? false : "set MIGRATE_TEST_DATABASE_URL to run",
}, async () => {
  const url = new URL(dbUrl as string);
  process.env.SOURCE_SECRET_REFS = `${REF}:${WORKSPACE}`;
  process.env[vars.username] = decodeURIComponent(url.username);
  process.env[vars.password] = decodeURIComponent(url.password);
  const real = source({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: url.pathname.slice(1),
    schema: "public",
  });
  const session: ExecutablePlan = {
    sql: `SELECT pg_backend_pid() AS pid,
                 current_setting('search_path') AS path,
                 current_setting('transaction_read_only') AS ro`,
    params: [],
  };

  try {
    const first = await executePlan(real, session);
    const second = await executePlan(real, session);
    assert.equal(second.rows[0].pid, first.rows[0].pid, "the connection is reused");
    assert.equal(first.rows[0].ro, "on");
    assert.equal(first.rows[0].path, "public, public");

    // A refused statement leaves the connection usable.
    await assert.rejects(
      executePlan(real, { sql: "SELECT nope", params: [] }),
      QueryExecutionError,
    );
    const after = await executePlan(real, session);
    assert.equal(after.rows[0].pid, first.rows[0].pid);

    // Outside an execution the same connection is out of any transaction,
    // with the search_path it had before the first one.
    const client = await sourcePool(real).connect();
    try {
      const { rows } = await client.query<{
        pid: number;
        path: string;
        ro: string;
        locks: string;
      }>(
        `SELECT pg_backend_pid() AS pid,
                current_setting('search_path') AS path,
                current_setting('transaction_read_only') AS ro,
                (SELECT count(*) FROM pg_locks WHERE pid = pg_backend_pid()
                   AND locktype = 'advisory')::text AS locks`,
      );
      assert.equal(rows[0].pid, first.rows[0].pid);
      assert.equal(rows[0].ro, "off");
      assert.equal(rows[0].path, '"$user", public');
      assert.equal(rows[0].locks, "0", "no advisory lock held");
    } finally {
      client.release();
    }

    // Never more than MAX_POOL_PER_SOURCE connections at once.
    const burst = await Promise.all(
      Array.from({ length: appConfig.maxPoolPerSource * 2 }, () =>
        executePlan(real, {
          sql: "SELECT pg_backend_pid() AS pid FROM pg_sleep(0.2)",
          params: [],
        }),
      ),
    );
    const pids = new Set(burst.map((r) => r.rows[0].pid));
    assert.ok(
      pids.size <= appConfig.maxPoolPerSource,
      `${pids.size} connections for a cap of ${appConfig.maxPoolPerSource}`,
    );
  } finally {
    await closeSourcePools();
  }
});
