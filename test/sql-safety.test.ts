import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { SourceConfig } from "@/lib/registry";
import { resolveTimeRange, resolveTimeExpr } from "@/lib/time";

const source = SourceConfig.parse({
  protocol: "http",
  host: "clickhouse",
  port: 8123,
  database: "metrics",
  tables: [
    {
      name: "http_requests",
      timeField: "ts",
      columns: [
        { name: "ts", type: "DateTime64(3)" },
        { name: "status", type: "UInt16" },
        { name: "duration_ms", type: "Float64" },
      ],
    },
  ],
});

test("accepts a plain SELECT against an allowlisted table", () => {
  const r = validateSql(
    "SELECT ts, count() AS c FROM http_requests GROUP BY ts",
    source,
  );
  assert.equal(r.ok, true, r.error);
});

test("accepts schema-qualified allowlisted table", () => {
  const r = validateSql("SELECT count() FROM metrics.http_requests", source);
  assert.equal(r.ok, true, r.error);
});

test("accepts WITH ... SELECT", () => {
  const r = validateSql(
    "WITH 1 AS one SELECT one, count() FROM http_requests",
    source,
  );
  assert.equal(r.ok, true, r.error);
});

test("rejects non-SELECT statements", () => {
  for (const sql of [
    "INSERT INTO http_requests VALUES (1)",
    "UPDATE http_requests SET status = 1",
    "DELETE FROM http_requests",
    "DROP TABLE http_requests",
    "ALTER TABLE http_requests ADD COLUMN x Int",
  ]) {
    assert.equal(validateSql(sql, source).ok, false, sql);
  }
});

test("rejects multiple statements", () => {
  const r = validateSql(
    "SELECT 1 FROM http_requests; SELECT 2 FROM http_requests",
    source,
  );
  assert.equal(r.ok, false);
});

test("rejects comments", () => {
  assert.equal(validateSql("SELECT 1 FROM http_requests -- x", source).ok, false);
  assert.equal(validateSql("SELECT 1 /* x */ FROM http_requests", source).ok, false);
  assert.equal(validateSql("SELECT 1 FROM http_requests # x", source).ok, false);
});

test("rejects dangerous table functions", () => {
  for (const sql of [
    "SELECT * FROM file('/etc/passwd')",
    "SELECT * FROM url('http://evil', CSV)",
    "SELECT * FROM remote('host', db.t)",
    "SELECT * FROM s3('http://x', CSV)",
    "SELECT * FROM mysql('h', 'd', 't', 'u', 'p')",
  ]) {
    assert.equal(validateSql(sql, source).ok, false, sql);
  }
});

test("rejects access to system tables / disallowed tables", () => {
  assert.equal(validateSql("SELECT * FROM system.tables", source).ok, false);
  assert.equal(validateSql("SELECT * FROM secret_table", source).ok, false);
});

test("rejects model-provided time / non-deterministic functions", () => {
  for (const sql of [
    "SELECT * FROM http_requests WHERE ts > now()",
    "SELECT today() FROM http_requests",
    "SELECT rand() FROM http_requests",
  ]) {
    assert.equal(validateSql(sql, source).ok, false, sql);
  }
});

test("buildExecutablePlan injects server-owned time range on timeField", () => {
  const from = new Date("2024-01-01T00:00:00.000Z");
  const to = new Date("2024-01-01T01:00:00.000Z");
  const plan = buildExecutablePlan({
    sql: "SELECT ts, count() FROM http_requests GROUP BY ts",
    timeField: "ts",
    from,
    to,
  });
  assert.match(plan.sql, /_holo\.ts >= \{holo_from:DateTime64\(3\)\}/);
  assert.match(plan.sql, /_holo\.ts < \{holo_to:DateTime64\(3\)\}/);
  assert.match(plan.sql, /LIMIT \d+/);
  assert.equal(plan.params.holo_from, "2024-01-01 00:00:00.000");
  assert.equal(plan.params.holo_to, "2024-01-01 01:00:00.000");
  assert.equal(plan.settings.readonly, "1");
});

test("buildExecutablePlan without timeField still bounds rows and omits time params", () => {
  const plan = buildExecutablePlan({
    sql: "SELECT count() FROM http_requests",
    from: new Date(),
    to: new Date(),
  });
  assert.match(plan.sql, /LIMIT \d+/);
  assert.equal(plan.params.holo_from, undefined);
  assert.equal(plan.params.holo_to, undefined);
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

test("resolveTimeExpr resolves relative expressions against a fixed now", () => {
  const now = new Date("2024-01-01T12:00:00.000Z");
  assert.equal(resolveTimeExpr("now", now).toISOString(), now.toISOString());
  assert.equal(
    resolveTimeExpr("now-1h", now).toISOString(),
    "2024-01-01T11:00:00.000Z",
  );
  assert.equal(
    resolveTimeExpr("now-15m", now).toISOString(),
    "2024-01-01T11:45:00.000Z",
  );
});

test("resolveTimeRange requires from < to", () => {
  const now = new Date("2024-01-01T12:00:00.000Z");
  const r = resolveTimeRange({ from: "now-1h", to: "now" }, now);
  assert.ok(r.from.getTime() < r.to.getTime());
  assert.throws(() => resolveTimeRange({ from: "now", to: "now-1h" }, now));
});
