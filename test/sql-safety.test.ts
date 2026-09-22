import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { SourceConfig } from "@/lib/registry";
import { resolveTimeRange, resolveTimeExpr } from "@/lib/time";
import { renderMetrics, resetMetricsForTests } from "@/lib/metrics";

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

test("accepts a plain SELECT against an allowlisted table", async () => {
  const r = await validateSql(
    "SELECT ts, count(*) AS c FROM http_requests GROUP BY ts",
    source,
  );
  assert.equal(r.ok, true, r.error);
});

test("accepts schema-qualified allowlisted table", async () => {
  const r = await validateSql("SELECT count(*) FROM metrics.http_requests", source);
  assert.equal(r.ok, true, r.error);
});

test("accepts WITH ... SELECT", async () => {
  const r = await validateSql(
    "WITH one AS (SELECT 1) SELECT count(*) FROM http_requests",
    source,
  );
  assert.equal(r.ok, true, r.error);
});

test("rejects non-SELECT statements", async () => {
  for (const sql of [
    "INSERT INTO http_requests VALUES (1)",
    "UPDATE http_requests SET status = 1",
    "DELETE FROM http_requests",
    "DROP TABLE http_requests",
    "ALTER TABLE http_requests ADD COLUMN x Int",
  ]) {
    assert.equal((await validateSql(sql, source)).ok, false, sql);
  }
});

test("rejects multiple statements", async () => {
  const r = await validateSql(
    "SELECT 1 FROM http_requests; SELECT 2 FROM http_requests",
    source,
  );
  assert.equal(r.ok, false);
});

test("rejects comments", async () => {
  assert.equal((await validateSql("SELECT 1 FROM http_requests -- x", source)).ok, false);
  assert.equal(
    (await validateSql("SELECT 1 /* x */ FROM http_requests", source)).ok,
    false,
  );
  assert.equal((await validateSql("SELECT 1 FROM http_requests # x", source)).ok, false);
});

test("rejects dangerous table functions", async () => {
  for (const sql of [
    "SELECT * FROM file('/etc/passwd')",
    "SELECT * FROM url('http://evil', CSV)",
    "SELECT * FROM remote('host', db.t)",
    "SELECT * FROM s3('http://x', CSV)",
    "SELECT * FROM mysql('h', 'd', 't', 'u', 'p')",
  ]) {
    assert.equal((await validateSql(sql, source)).ok, false, sql);
  }
});

test("rejects access to system tables / disallowed tables", async () => {
  assert.equal((await validateSql("SELECT * FROM system.tables", source)).ok, false);
  assert.equal((await validateSql("SELECT * FROM secret_table", source)).ok, false);
});

test("rejects model-provided time / non-deterministic functions", async () => {
  for (const sql of [
    "SELECT * FROM http_requests WHERE ts > now()",
    "SELECT today() FROM http_requests",
    "SELECT rand() FROM http_requests",
    "SELECT current_timestamp FROM http_requests",
  ]) {
    assert.equal((await validateSql(sql, source)).ok, false, sql);
  }
});

test("rejects server parameter references and privileged PostgreSQL functions", async () => {
  assert.equal((await validateSql("SELECT $1 FROM http_requests", source)).ok, false);
  assert.equal(
    (await validateSql("SELECT pg_read_file('/etc/passwd') FROM http_requests", source))
      .ok,
    false,
  );
});

test("buildExecutablePlan injects server-owned time range on timeField", () => {
  const from = new Date("2024-01-01T00:00:00.000Z");
  const to = new Date("2024-01-01T01:00:00.000Z");
  const plan = buildExecutablePlan({
    sql: "SELECT ts, count(*) FROM http_requests GROUP BY ts",
    timeField: "ts",
    from,
    to,
  });
  assert.match(plan.sql, /_holo\.ts >= \$1::timestamptz/);
  assert.match(plan.sql, /_holo\.ts < \$2::timestamptz/);
  assert.match(plan.sql, /LIMIT \d+/);
  assert.deepEqual(plan.params, [from, to]);
  // The plan carries the filtered column so the executor can translate a
  // Postgres "column _holo.ts does not exist" (42703) into an actionable error.
  assert.equal(plan.timeField, "ts");
});

test("buildExecutablePlan without timeField still bounds rows and omits time params", () => {
  const plan = buildExecutablePlan({
    sql: "SELECT count(*) FROM http_requests",
    from: new Date(),
    to: new Date(),
  });
  assert.match(plan.sql, /LIMIT \d+/);
  assert.deepEqual(plan.params, []);
});

test("buildExecutablePlan rejects an injection-shaped timeField", () => {
  assert.throws(() =>
    buildExecutablePlan({
      sql: "SELECT 1 FROM http_requests",
      timeField: "ts; DROP TABLE",
      from: new Date(),
      to: new Date(),
    }),
  );
});

test("every trailing terminator is stripped before the query is wrapped", async () => {
  // Found by test/sql-safety.fuzz.test.ts. PostgreSQL reads `SELECT 1;;` as one
  // statement, so the guard accepted it, but only one `;` was stripped and the
  // wrapped plan `SELECT * FROM (SELECT 1 FROM http_requests;) AS _holo …` was a
  // syntax error at execution time.
  for (const sql of [
    "SELECT 1 FROM http_requests;;",
    "SELECT 1 FROM http_requests ; ;\n",
    "SELECT 1 FROM http_requests;\n;\t",
  ]) {
    const r = await validateSql(sql, source);
    assert.equal(r.ok, true, r.error);
    const plan = buildExecutablePlan({
      sql,
      timeField: "ts",
      from: new Date(0),
      to: new Date(1),
    });
    assert.doesNotMatch(plan.sql, /;\)/, plan.sql);
    assert.match(plan.sql, /\(SELECT 1 FROM http_requests\) AS _holo/);
  }
});

test("resolveTimeExpr resolves relative expressions against a fixed now", () => {
  const now = new Date("2024-01-01T12:00:00.000Z");
  assert.equal(resolveTimeExpr("now", now).toISOString(), now.toISOString());
  assert.equal(resolveTimeExpr("now-1h", now).toISOString(), "2024-01-01T11:00:00.000Z");
  assert.equal(resolveTimeExpr("now-15m", now).toISOString(), "2024-01-01T11:45:00.000Z");
});

test("resolveTimeRange requires from < to", () => {
  const now = new Date("2024-01-01T12:00:00.000Z");
  const r = resolveTimeRange({ from: "now-1h", to: "now" }, now);
  assert.ok(r.from.getTime() < r.to.getTime());
  assert.throws(() => resolveTimeRange({ from: "now", to: "now-1h" }, now));
});

/**
 * Every rejection carries a `reason` from a fixed enum, because that — never
 * the `error` string, which names the offending table or function — is what
 * `holotable_sql_validation_rejections_total` uses as a label. A rule that
 * stopped reporting its reason would be a metric that silently went blind, so
 * the mapping is pinned here alongside the guard itself.
 */
test("every rule reports the class of rule that refused the statement", async () => {
  const cases: Array<[reason: string, sql: string]> = [
    ["empty", "   "],
    ["structure", "INSERT INTO http_requests (status) VALUES (200)"],
    ["structure", "SELECT 1 FROM http_requests; SELECT 2 FROM http_requests"],
    ["comment", "SELECT ts FROM http_requests -- and the rest"],
    ["keyword", "SELECT current_user FROM http_requests"],
    ["function", "SELECT pg_read_file('/etc/passwd') FROM http_requests"],
    ["time", "SELECT now() FROM http_requests"],
    ["time", "SELECT ts FROM http_requests WHERE ts > 'now'"],
    ["catalog", "SELECT * FROM pg_catalog.pg_authid"],
  ];
  for (const [reason, sql] of cases) {
    const r = await validateSql(sql, source);
    assert.equal(r.ok, false, `expected ${sql} to be refused`);
    assert.equal(r.reason, reason, `${sql} -> ${r.error}`);
  }
});

test("an accepted statement carries no rejection reason", async () => {
  const r = await validateSql("SELECT ts FROM http_requests", source);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.reason, undefined);
});

test("a rejection is counted once, under its own reason", async () => {
  resetMetricsForTests();
  await validateSql("SELECT * FROM pg_catalog.pg_authid", source);
  await validateSql("SELECT * FROM pg_catalog.pg_authid", source);
  await validateSql("SELECT now() FROM http_requests", source);
  await validateSql("SELECT ts FROM http_requests", source);

  const scrape = await renderMetrics();
  assert.match(scrape, /holotable_sql_validation_rejections_total\{reason="catalog"\} 2/);
  assert.match(scrape, /holotable_sql_validation_rejections_total\{reason="time"\} 1/);
});
