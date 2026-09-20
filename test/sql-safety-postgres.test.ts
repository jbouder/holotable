import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSql } from "@/lib/sql/safety";
import { SourceConfig } from "@/lib/registry";

/**
 * PostgreSQL-specific guard coverage, and a characterization of what the
 * current denylist does and does not do.
 *
 * `test/sql-safety.test.ts` was written against a largely ClickHouse
 * vocabulary — `now64`, `today`, `remote`, `s3`, `format` — while the database
 * this actually runs against is PostgreSQL/TimescaleDB. These tests cover the
 * PostgreSQL side: the synonyms that made the "server owns time" invariant
 * unenforced, and the functions that took a query string and walked around the
 * catalog allowlist.
 *
 * The final block pins known *over*-rejections. They are not security bugs —
 * they fail closed — but they reject ordinary SQL, and a reader should be able
 * to tell a deliberate limitation from an accident. AST validation (#10) is
 * expected to flip those assertions; that is the point of writing them down.
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

function rejects(sql: string) {
  assert.equal(
    validateSql(sql, source).ok,
    false,
    `expected rejection, got ok for: ${sql}`,
  );
}

function accepts(sql: string) {
  const r = validateSql(sql, source);
  assert.equal(r.ok, true, `expected acceptance, got "${r.error}" for: ${sql}`);
}

test("rejects every PostgreSQL synonym for the current time", () => {
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
    rejects(`SELECT ${fn} FROM http_requests`);
    rejects(`SELECT ts FROM http_requests WHERE ts > ${fn}`);
  }
});

test("rejects parenless PostgreSQL time and identity keywords", () => {
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
    rejects(`SELECT ${kw} FROM http_requests`);
  }
});

test("rejects PostgreSQL non-deterministic value functions", () => {
  // A spec must produce the same query on every poller tick. These do not.
  for (const fn of ["random()", "gen_random_uuid()", "uuid_generate_v4()"]) {
    rejects(`SELECT ${fn} FROM http_requests`);
  }
});

test("rejects functions that execute a query string", () => {
  // These take SQL as a text argument and run it, so the catalog allowlist
  // never sees the tables they touch. The application's read-only role holds
  // SELECT on the entire metrics schema, not just the catalog tables, so this
  // reaches real data rather than merely erroring out.
  rejects(
    "SELECT query_to_xml('SELECT * FROM metrics.other', true, true, '') FROM http_requests",
  );
  rejects("SELECT table_to_xml('metrics.other', true, true, '') FROM http_requests");
  rejects("SELECT query_to_xmlschema('SELECT 1', true, true, '') FROM http_requests");
  rejects("SELECT cursor_to_xml('c', 1, true, true, '') FROM http_requests");
});

test("rejects PostgreSQL filesystem and server-metadata functions", () => {
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
    rejects(`SELECT ${call} FROM http_requests`);
  }
});

test("rejects unbounded server-side delay", () => {
  // The statement timeout caps one call, but a poller tick that always burns
  // its full timeout holds a connection open every tick, for every subscriber.
  for (const call of [
    "pg_sleep(10)",
    "pg_sleep_for('5 minutes')",
    "pg_sleep_until('2030-01-01')",
  ]) {
    rejects(`SELECT ${call} FROM http_requests`);
  }
});

test("rejects cross-database and large-object access", () => {
  rejects("SELECT dblink('host=evil', 'SELECT 1') FROM http_requests");
  rejects("SELECT lo_import('/etc/passwd') FROM http_requests");
  rejects("SELECT lo_export(1, '/tmp/out') FROM http_requests");
});

test("accepts the SQL the seeded demo dashboards actually run", () => {
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
    const r = validateSql(sql, demo);
    assert.equal(r.ok, true, `seeded demo query rejected: ${r.error}\n  ${sql}`);
  }
});

test("accepts ordinary analytic SQL", () => {
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
    accepts(sql);
  }
});

test("a CTE body may read an allowlisted table", () => {
  // Regression: the table-reference scan used to capture the trailing `)` of a
  // CTE body, so `FROM http_requests)` was read as an invalid identifier and
  // every CTE over a real table was rejected.
  accepts("WITH b AS (SELECT ts FROM http_requests) SELECT count(*) FROM http_requests");
});

// ---------------------------------------------------------------------------
// Known over-rejections.
//
// These fail closed, so they are not security bugs — but they reject valid,
// ordinary SQL, and the model does generate these shapes. A regex cannot fix
// them: distinguishing a table reference from `FROM` used as function syntax,
// or from a name the query itself defines, needs a parser. AST validation
// (#10) should flip every assertion in this block, and flipping them is the
// signal that it worked.
// ---------------------------------------------------------------------------

test("known limitation: `FROM` inside a function call reads as a table reference", () => {
  // `extract(epoch FROM ts)` is standard SQL. The scan sees `FROM ts`.
  rejects("SELECT extract(epoch FROM ts) FROM http_requests");
  rejects("SELECT substring(route FROM 1 FOR 3) FROM http_requests");
  rejects("SELECT trim(BOTH ' ' FROM route) FROM http_requests");
});

test("known limitation: a CTE alias is not a recognised name", () => {
  // The guard has no notion of names the query defines, so selecting from a
  // CTE by its alias is rejected as a table outside the catalog.
  rejects("WITH b AS (SELECT ts FROM http_requests) SELECT count(*) FROM b");
});

test("known limitation: a keyword inside a string literal is rejected", () => {
  // The denylist scans raw text, so a literal containing a forbidden word is
  // indistinguishable from the keyword itself.
  rejects("SELECT 'insert' FROM http_requests");
  rejects("SELECT route FROM http_requests WHERE route = '/set'");
});

test("known limitation: a column sharing a name with a keyword is rejected", () => {
  rejects("SELECT format FROM http_requests");
  rejects("SELECT set FROM http_requests");
});
