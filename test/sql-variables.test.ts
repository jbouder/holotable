import { before, test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "libpg-query";
import { type SqlSourceConfig, TimescaleDbConfig } from "@/lib/registry";
import { analyzeSelectSync } from "@/lib/sql/ast";
import { buildExecutablePlan, checkSql } from "@/lib/sql/safety";
import { scanVariables, VariableError } from "@/lib/sql/variables";

/**
 * Dashboard variables in the SQL guard (#67): a `:name` is found by the
 * server's scanner, must be declared, and its value is only ever a bound
 * parameter.
 */

before(async () => {
  await loadModule();
});

const source = TimescaleDbConfig.parse({
  host: "db",
  port: 5432,
  database: "metrics",
  schema: "metrics",
  tables: [
    {
      name: "m",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamptz" },
        { name: "host", type: "text" },
        { name: "region", type: "text" },
        { name: "v", type: "integer" },
      ],
    },
  ],
});

const declared = new Set(["host", "hosts", "region"]);
const FROM = new Date("2026-10-04T00:00:00Z");
const TO = new Date("2026-10-04T01:00:00Z");

test("a declared reference passes, as the parameter it will run as", async () => {
  for (const sql of [
    "SELECT ts, v FROM m WHERE host = :host",
    "SELECT ts, v FROM m WHERE host = ANY(:hosts) AND region = :region",
    "SELECT ts, v FROM m WHERE host = :host OR region = :host",
    "SELECT ts, v::text FROM m WHERE host = :host::text",
  ]) {
    assert.deepEqual(await checkSql(sql, source, declared), { ok: true }, sql);
  }
});

test("an undeclared reference is refused, by name", async () => {
  const result = await checkSql(
    "SELECT v FROM m WHERE host = :hostname",
    source,
    declared,
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "variable");
  assert.match(result.error ?? "", /undeclared variable :hostname/);
  // Without a dashboard that declares any, every reference is undeclared.
  const bare = await checkSql("SELECT v FROM m WHERE host = :host", source);
  assert.equal(bare.reason, "variable");
  // Names are exact: the IR only allows lowercase ones.
  assert.equal(
    (await checkSql("SELECT v FROM m WHERE host = :Host", source, declared)).reason,
    "variable",
  );
});

test("only the scanner decides what is a reference", async () => {
  const notRefs = [
    "SELECT v FROM m WHERE host = ':nope'",
    "SELECT v FROM m WHERE host = $$:nope$$",
    "SELECT v FROM m WHERE host = E'\\':nope'",
    'SELECT v AS ":nope" FROM m',
    "SELECT v::text FROM m",
  ];
  for (const sql of notRefs) {
    assert.deepEqual((await scanVariables(sql)).refs, [], sql);
    assert.deepEqual(await checkSql(sql, source, new Set()), { ok: true }, sql);
  }
  // Spaced or quoted, it is not a reference, and the grammar refuses it.
  for (const sql of [
    "SELECT v FROM m WHERE host = : host",
    'SELECT v FROM m WHERE host = :"host"',
  ]) {
    const result = await checkSql(sql, source, declared);
    assert.equal(result.ok, false, sql);
    assert.equal(result.reason, "structure", sql);
  }
  // A comment is still refused, reference or not.
  assert.equal(
    (await checkSql("SELECT v FROM m WHERE host = :host -- :x", source, declared)).reason,
    "comment",
  );
});

test("a statement's own $n is refused before any placeholder is accepted", async () => {
  for (const sql of [
    "SELECT v FROM m WHERE host = $1",
    "SELECT v FROM m WHERE host = :host OR host = $1",
    "SELECT v FROM m WHERE host = :host OR host = $2",
  ]) {
    const result = await checkSql(sql, source, declared);
    assert.equal(result.ok, false, sql);
    assert.match(result.error ?? "", /reserved by the server/, sql);
  }
});

test("the guard's other rules still see through a reference", async () => {
  const result = await checkSql(
    "SELECT v FROM m WHERE host = :host UNION SELECT 1 FROM pg_catalog.pg_user",
    source,
    declared,
  );
  assert.equal(result.reason, "catalog");
  assert.equal(
    (await checkSql("SELECT pg_sleep(:host)", source, declared)).reason,
    "function",
  );
});

test("a value is a bound parameter and never part of the statement text", () => {
  const hostile = "x'); DROP TABLE m; --";
  const plan = buildExecutablePlan({
    sql: "SELECT ts, v FROM m WHERE host = :host AND (region = :region OR :host = 'all')",
    timeField: "ts",
    from: FROM,
    to: TO,
    rowFilter: null,
    variables: { host: hostile, region: "eu", unused: "u" },
  });
  assert.equal(plan.sql.includes(hostile), false);
  assert.equal(plan.sql.includes("eu"), false);
  assert.match(plan.sql, /host = \$3 AND \(region = \$4 OR \$3 = 'all'\)/);
  assert.deepEqual(plan.params, [FROM, TO, hostile, "eu"]);
  assert.ok(analyzeSelectSync(plan.sql, { params: true }).ok);
});

test("a multi-value variable binds an array", () => {
  const plan = buildExecutablePlan({
    sql: "SELECT v FROM m WHERE host = ANY(:hosts)",
    from: FROM,
    to: TO,
    rowFilter: null,
    variables: { hosts: ["a", "b"] },
  });
  assert.match(plan.sql, /host = ANY\(\$1\)/);
  assert.deepEqual(plan.params, [["a", "b"]]);
});

test("placeholders follow the time bounds and the row-filter value", () => {
  const plan = buildExecutablePlan({
    sql: "SELECT ts, v FROM m WHERE host = :host",
    timeField: "ts",
    from: FROM,
    to: TO,
    rowFilter: { column: "host", value: "tenant-a" },
    variables: { host: "h1" },
  });
  assert.deepEqual(plan.params, [FROM, TO, "tenant-a", "h1"]);
  assert.match(plan.sql, /_holo_rf\.host = \$3/);
  assert.match(plan.sql, /WHERE host = \$4/);
});

test("a reference without a value, or a $n of its own, builds no plan", () => {
  assert.throws(
    () =>
      buildExecutablePlan({
        sql: "SELECT v FROM m WHERE host = :host",
        from: FROM,
        to: TO,
        rowFilter: null,
      }),
    VariableError,
  );
  assert.throws(
    () =>
      buildExecutablePlan({
        sql: "SELECT v FROM m WHERE host = $1",
        from: FROM,
        to: TO,
        rowFilter: null,
        variables: {},
      }),
    VariableError,
  );
});

test("references are found by byte offset in text that is not ASCII", async () => {
  const sql = "SELECT v AS \"größe\" FROM m WHERE host = :host AND region = 'é:x'";
  const { refs } = await scanVariables(sql);
  assert.deepEqual(
    refs.map((r) => r.name),
    ["host"],
  );
  const plan = buildExecutablePlan({
    sql,
    from: FROM,
    to: TO,
    rowFilter: null,
    variables: { host: "h" },
  });
  assert.match(plan.sql, /AS "größe" FROM m WHERE host = \$1 AND region = 'é:x'/);
});
