import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSql } from "@/lib/sql/safety";
import { SourceConfig } from "@/lib/registry";

/**
 * PostgreSQL-specific guard coverage.
 *
 * `test/sql-safety.test.ts` was written against a largely ClickHouse
 * vocabulary — `now64`, `today`, `remote`, `s3`, `format` — while the database
 * this actually runs against is PostgreSQL/TimescaleDB. These tests cover the
 * PostgreSQL side: the synonyms that made the "server owns time" invariant
 * unenforced, and the functions that took a query string and walked around the
 * catalog allowlist.
 *
 * The final block holds the statements the regex guard used to over-reject.
 * They were written down as `rejects(...)` to characterize the denylist, and
 * flipped to `accepts(...)` when the parse-tree validator (#10) replaced it.
 */

const source = SourceConfig.parse({
  host: "postgres",
  port: 5432,
  database: "holotable",
  schema: "metrics",
  ssl: false,
  tables: [
    {
      name: "http_requests",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamp with time zone" },
        { name: "status", type: "smallint" },
        { name: "duration_ms", type: "double precision" },
      ],
    },
  ],
});

async function rejects(sql: string) {
  assert.equal(
    (await validateSql(sql, source)).ok,
    false,
    `expected rejection, got ok for: ${sql}`,
  );
}

async function accepts(sql: string) {
  const r = await validateSql(sql, source);
  assert.equal(r.ok, true, `expected acceptance, got "${r.error}" for: ${sql}`);
}

test("rejects every PostgreSQL synonym for the current time", async () => {
  // Invariant 8 says the server owns the time range. Blocking now() and
  // current_timestamp does not achieve that on PostgreSQL: each of these
  // returns a clock reading, and clock_timestamp() is not even stable within
  // a statement.
  for (const fn of [
    "clock_timestamp()",
    "statement_timestamp()",
    "transaction_timestamp()",
    "timeofday()",
  ]) {
    await rejects(`SELECT ${fn} FROM http_requests`);
    await rejects(`SELECT ts FROM http_requests WHERE ts > ${fn}`);
  }
});

test("rejects parenless PostgreSQL time and identity keywords", async () => {
  for (const kw of [
    "current_timestamp",
    "current_date",
    "current_time",
    "localtime",
    "localtimestamp",
    "current_user",
    "session_user",
    "current_catalog",
    "current_schema",
    "current_role",
  ]) {
    await rejects(`SELECT ${kw} FROM http_requests`);
  }
});

test("rejects PostgreSQL non-deterministic value functions", async () => {
  // A spec must produce the same query on every poller tick. These do not.
  for (const fn of ["random()", "gen_random_uuid()", "uuid_generate_v4()"]) {
    await rejects(`SELECT ${fn} FROM http_requests`);
  }
});

test("rejects functions that execute a query string", async () => {
  // These take SQL as a text argument and run it, so the catalog allowlist
  // never sees the tables they touch. The application's read-only role holds
  // SELECT on the entire metrics schema, not just the catalog tables, so this
  // reaches real data rather than merely erroring out.
  await rejects(
    "SELECT query_to_xml('SELECT * FROM metrics.other', true, true, '') FROM http_requests",
  );
  await rejects(
    "SELECT table_to_xml('metrics.other', true, true, '') FROM http_requests",
  );
  await rejects(
    "SELECT query_to_xmlschema('SELECT 1', true, true, '') FROM http_requests",
  );
  await rejects("SELECT cursor_to_xml('c', 1, true, true, '') FROM http_requests");
});

test("rejects PostgreSQL filesystem and server-metadata functions", async () => {
  for (const call of [
    "pg_read_file('/etc/passwd')",
    "pg_read_binary_file('/etc/passwd')",
    "pg_stat_file('/etc/passwd')",
    "pg_ls_dir('/')",
    "pg_ls_logdir()",
    "pg_ls_waldir()",
    "current_setting('is_superuser')",
    "set_config('work_mem', '1GB', false)",
    "version()",
    "inet_server_addr()",
    "pg_backend_pid()",
  ]) {
    await rejects(`SELECT ${call} FROM http_requests`);
  }
});

test("rejects unbounded server-side delay", async () => {
  // The statement timeout caps one call, but a poller tick that always burns
  // its full timeout holds a connection open every tick, for every subscriber.
  for (const call of [
    "pg_sleep(10)",
    "pg_sleep_for('5 minutes')",
    "pg_sleep_until('2030-01-01')",
  ]) {
    await rejects(`SELECT ${call} FROM http_requests`);
  }
});

test("rejects cross-database and large-object access", async () => {
  await rejects("SELECT dblink('host=evil', 'SELECT 1') FROM http_requests");
  await rejects("SELECT lo_import('/etc/passwd') FROM http_requests");
  await rejects("SELECT lo_export(1, '/tmp/out') FROM http_requests");
});

test("accepts the SQL the seeded demo dashboards actually run", async () => {
  // The guard is worthless if it rejects the product's own queries. These are
  // verbatim from scripts/seed.ts, against the source they are seeded for.
  const demo = SourceConfig.parse({
    host: "postgres",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables: [
      {
        name: "http_requests",
        timeField: "ts",
        columns: [{ name: "ts", type: "timestamptz" }],
      },
      {
        name: "system_metrics",
        timeField: "ts",
        columns: [{ name: "ts", type: "timestamptz" }],
      },
    ],
  });
  for (const sql of [
    "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS requests FROM http_requests GROUP BY minute ORDER BY minute",
    "SELECT time_bucket('1 minute', ts) AS minute, percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95 FROM http_requests GROUP BY minute ORDER BY minute",
    "SELECT time_bucket('1 minute', ts) AS minute, count(*) FILTER (WHERE status >= 500) AS errors FROM http_requests GROUP BY minute ORDER BY minute",
    "SELECT route, count(*) AS requests FROM http_requests GROUP BY route ORDER BY requests DESC",
    "SELECT time_bucket('1 minute', ts) AS minute, host, avg(cpu_pct) AS cpu FROM system_metrics GROUP BY minute, host ORDER BY minute",
    "SELECT time_bucket('1 minute', ts) AS minute, host, avg(mem_pct) AS mem FROM system_metrics GROUP BY minute, host ORDER BY minute",
    "SELECT time_bucket('1 minute', ts) AS minute, max(disk_pct) AS disk FROM system_metrics GROUP BY minute ORDER BY minute",
    "SELECT region, round(avg(cpu_pct)::numeric, 1) AS avg_cpu FROM system_metrics GROUP BY region ORDER BY avg_cpu DESC",
  ]) {
    const r = await validateSql(sql, demo);
    assert.equal(r.ok, true, `seeded demo query rejected: ${r.error}\n  ${sql}`);
  }
});

test("accepts ordinary analytic SQL", async () => {
  for (const sql of [
    "SELECT ts, status FROM http_requests WHERE status = 500",
    "SELECT count(*) FROM metrics.http_requests",
    "SELECT date_trunc('hour', ts) AS h, count(*) FROM http_requests GROUP BY h",
    "SELECT ts, lag(duration_ms) OVER (ORDER BY ts) FROM http_requests",
    "SELECT coalesce(avg(duration_ms), 0) FROM http_requests",
    "SELECT ts AT TIME ZONE 'UTC' FROM http_requests",
    "SELECT * FROM (SELECT ts FROM http_requests) t",
    "SELECT * FROM http_requests LIMIT 10 OFFSET 5",
  ]) {
    await accepts(sql);
  }
});

test("a CTE body may read an allowlisted table", async () => {
  // Regression: the table-reference scan used to capture the trailing `)` of a
  // CTE body, so `FROM http_requests)` was read as an invalid identifier and
  // every CTE over a real table was rejected.
  await accepts(
    "WITH b AS (SELECT ts FROM http_requests) SELECT count(*) FROM http_requests",
  );
});

// ---------------------------------------------------------------------------
// Former over-rejections.
//
// Under the regex guard every statement in this block was rejected: the scan
// read `FROM` inside a function call as a table reference, had no notion of a
// name the query itself defines, and could not tell a keyword from a string
// literal or a column that happens to share its name. They failed closed, so
// they were never security bugs — but the model generates these shapes, and
// each one was a panel that could not render. The parser distinguishes all of
// them, so every assertion here is the inverse of what it was, on purpose.
// ---------------------------------------------------------------------------

test("`FROM` inside a function call is not a table reference", async () => {
  await accepts("SELECT extract(epoch FROM ts) FROM http_requests");
  await accepts("SELECT substring(route FROM 1 FOR 3) FROM http_requests");
  await accepts("SELECT trim(BOTH ' ' FROM route) FROM http_requests");
});

test("a CTE alias is a recognised name", async () => {
  await accepts("WITH b AS (SELECT ts FROM http_requests) SELECT count(*) FROM b");
});

test("a keyword inside a string literal is just a string", async () => {
  await accepts("SELECT 'insert' FROM http_requests");
  await accepts("SELECT route FROM http_requests WHERE route = '/set'");
});

test("a column sharing a name with a keyword is just a column", async () => {
  await accepts("SELECT format FROM http_requests");
  await accepts("SELECT set FROM http_requests");
});
