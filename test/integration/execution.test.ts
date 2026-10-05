import assert from "node:assert/strict";
import { after, test } from "node:test";
import { config } from "@/lib/config";
import type { QueryPanel } from "@/lib/ir";
import { makePanelExecutor } from "@/lib/poller/registry";
import type { SourceRecord } from "@/lib/registry";
import { buildExecutablePlan, type ExecutablePlan, validateSql } from "@/lib/sql/safety";
import { executePlan, QueryExecutionError } from "@/lib/timescaledb/client";
import { closeSourcePools } from "@/lib/timescaledb/pool";
import { grantRef, metricsSource, needsDb, unique } from "./support";

/*
 * The execution layer against a real TimescaleDB (#87): what `executePlan`
 * promises about the session it runs a plan in, proven on the server rather
 * than on a fake pool. Each plan here is handed to `executePlan` directly,
 * bypassing the guard on purpose, so what is under test is the layer that
 * holds even when the guard is wrong.
 */

const WORKSPACE = unique("ws-exec");

/** A source as configured in production: the read-only role on `metrics`. */
function readOnlySource(): SourceRecord {
  grantRef("HT_IT_EXEC", WORKSPACE, "readonly");
  return metricsSource({
    id: unique("src-exec"),
    workspaceId: WORKSPACE,
    secretRef: "HT_IT_EXEC",
  });
}

/** The same source logged in as the database owner, a role that may write. */
function ownerSource(): SourceRecord {
  grantRef("HT_IT_OWNER", WORKSPACE, "owner");
  return metricsSource({
    id: unique("src-owner"),
    workspaceId: WORKSPACE,
    secretRef: "HT_IT_OWNER",
  });
}

function plan(sql: string): ExecutablePlan {
  return { sql, params: [] };
}

after(async () => {
  await closeSourcePools();
});

test(
  "a plan runs read-only with search_path pinned to the source schema",
  needsDb,
  async () => {
    const source = readOnlySource();
    const { rows } = await executePlan(
      source,
      plan(`SELECT current_setting('search_path') AS path,
                 current_setting('transaction_read_only') AS ro,
                 current_user AS who`),
    );
    assert.equal(rows[0].path, "metrics, public");
    assert.equal(rows[0].ro, "on");
    assert.equal(rows[0].who, process.env.INTEGRATION_METRICS_USERNAME ?? "metrics_ro");

    // The catalog advertises bare names; they resolve against the pinned schema,
    // and the TimescaleDB functions in `public` stay reachable.
    const bare = await executePlan(
      source,
      plan(
        "SELECT count(*)::int AS n, time_bucket('1 minute', now()) AS b FROM http_requests",
      ),
    );
    assert.equal(typeof bare.rows[0].n, "number");
  },
);

test(
  "a write fails inside the read-only transaction, whatever the role",
  needsDb,
  async () => {
    const writes = [
      "INSERT INTO http_requests (service, route, status, duration_ms, bytes) VALUES ('it', '/', 200, 1, 1)",
      "WITH gone AS (DELETE FROM http_requests WHERE service = 'it' RETURNING *) SELECT count(*) FROM gone",
      "CREATE TABLE it_write_probe (i int)",
      "SELECT set_config('search_path', 'public', false)",
    ];
    for (const source of [readOnlySource(), ownerSource()]) {
      for (const sql of writes.slice(0, 3)) {
        await assert.rejects(
          executePlan(source, plan(sql)),
          (err: unknown) =>
            err instanceof QueryExecutionError &&
            /read-only transaction/.test(err.message),
          `${source.secretRef}: ${sql}`,
        );
      }
      // A session setting changed by a statement does not outlive its execution:
      // the rollback undoes it before the connection goes back to the pool.
      await executePlan(source, plan(writes[3]));
      const { rows } = await executePlan(
        source,
        plan("SELECT current_setting('search_path') AS p"),
      );
      assert.equal(rows[0].p, "metrics, public");
    }

    // And nothing was written, read back outside any execution.
    const owner = ownerSource();
    const { rows } = await executePlan(
      owner,
      plan(
        "SELECT count(*)::int AS n, to_regclass('metrics.it_write_probe') AS probe FROM http_requests WHERE service = 'it'",
      ),
    );
    assert.deepEqual(rows[0], { n: 0, probe: null });
  },
);

test("statement_timeout cancels a statement that runs too long", needsDb, async () => {
  const source = readOnlySource();
  const started = Date.now();
  await assert.rejects(
    executePlan(source, plan(`SELECT pg_sleep(${config.queryTimeoutSeconds + 3})`)),
    (err: unknown) =>
      err instanceof QueryExecutionError && /statement timeout/.test(err.message),
  );
  assert.ok(Date.now() - started < (config.queryTimeoutSeconds + 2) * 1000);
  // The cancelled statement left the pooled connection usable.
  const { rows } = await executePlan(source, plan("SELECT 1 AS one"));
  assert.equal(rows[0].one, 1);
});

test(
  "SQLSTATE failures become QueryExecutionError; connection failures do not",
  needsDb,
  async () => {
    const source = readOnlySource();
    const statementFailures: [string, RegExp][] = [
      ["SELECT nope FROM http_requests", /column "nope" does not exist/],
      ["SELECT 1 / 0", /division by zero/],
      ["SELECT FROM WHERE", /syntax error/],
      ["SELECT 'x'::int", /invalid input syntax/],
    ];
    for (const [sql, message] of statementFailures) {
      await assert.rejects(
        executePlan(source, plan(sql)),
        (err: unknown) => err instanceof QueryExecutionError && message.test(err.message),
        sql,
      );
    }

    // Nothing listens on port 1: a socket error, never shown to a viewer as
    // though it were the author's SQL.
    const unreachable: SourceRecord = {
      ...source,
      id: unique("src-down"),
      config: { ...source.config, host: "127.0.0.1", port: 1 },
    };
    await assert.rejects(executePlan(unreachable, plan("SELECT 1")), (err: unknown) => {
      assert.ok(
        !(err instanceof QueryExecutionError),
        "a connection failure is not a statement failure",
      );
      return true;
    });
  },
);

test(
  "a timeField the query does not produce gets the actionable message",
  needsDb,
  async () => {
    const source = readOnlySource();
    const sql =
      "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS n FROM http_requests GROUP BY minute";
    const check = await validateSql(sql, source.config);
    assert.ok(check.ok, check.error);
    const executable = buildExecutablePlan({
      sql,
      timeField: "bucket",
      from: new Date(Date.now() - 3_600_000),
      to: new Date(),
      rowFilter: null,
    });
    await assert.rejects(
      executePlan(source, executable),
      (err: unknown) =>
        err instanceof QueryExecutionError &&
        /time column "bucket" is not produced by this query/.test(err.message) &&
        /AS bucket/.test(err.message),
    );
  },
);

test("a table outside the allowlist is refused end to end", needsDb, async () => {
  const source = readOnlySource();
  const executor = makePanelExecutor(async (id) => (id === source.id ? source : null));
  const panel = (sql: string): QueryPanel => ({
    id: "p",
    title: "p",
    viz: "table",
    query: { sourceId: source.id, sql },
    layout: { x: 0, y: 0, w: 4, h: 3 },
  });
  const window = { from: new Date(Date.now() - 3_600_000), to: new Date() };

  // Not in this source's allowlist, though the role could read it.
  for (const sql of [
    "SELECT * FROM system_metrics",
    "SELECT * FROM metrics.system_metrics",
    "SELECT * FROM public.sources",
    "SELECT * FROM pg_catalog.pg_authid",
  ]) {
    const events = await executor(panel(sql), window, WORKSPACE, {}, {});
    assert.equal(events.length, 1, sql);
    assert.equal(events[0].type, "panel-error", sql);
    assert.equal(events[0].type === "panel-error" && events[0].kind, "statement", sql);
  }

  // The allowlisted table runs.
  const ok = await executor(
    panel("SELECT count(*) AS n FROM http_requests"),
    window,
    WORKSPACE,
    {},
    {},
  );
  assert.equal(ok[0].type, "panel");

  // And behind the guard, the role itself: a plan that reached the server
  // anyway still cannot read the config store.
  await assert.rejects(
    executePlan(source, plan("SELECT * FROM public.sources")),
    (err: unknown) =>
      err instanceof QueryExecutionError && /permission denied/.test(err.message),
  );
});
