import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSync } from "libpg-query";
import { config } from "@/lib/config";
import { validateSql, buildExecutablePlan, verifyWrapper } from "@/lib/sql/safety";
import { TimescaleDbConfig } from "@/lib/registry";
import { resolveTimeRange, resolveTimeExpr, TimeRangeError } from "@/lib/time";
import { renderMetrics, resetMetricsForTests } from "@/lib/metrics";

const source = TimescaleDbConfig.parse({
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
    rowFilter: null,
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
    rowFilter: null,
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
      rowFilter: null,
    }),
  );
});

/* -------------------------------------------------------------------------- */
/* The row cap keeps the live edge (#486)                                     */
/* -------------------------------------------------------------------------- */

type Tree = Record<string, unknown>;
const stmtOf = (sql: string): Tree =>
  (parseSync(sql) as { stmts: Array<{ stmt: { SelectStmt: Tree } }> }).stmts[0].stmt
    .SelectStmt;
const subOf = (n: Tree): { alias: string; select: Tree } => {
  const range = (n.fromClause as Array<{ RangeSubselect: Tree }>)[0].RangeSubselect;
  return {
    alias: (range.alias as { aliasname: string }).aliasname,
    select: (range.subquery as { SelectStmt: Tree }).SelectStmt,
  };
};
const sortKeys = (n: Tree) =>
  (n.sortClause as Array<{ SortBy: Tree }> | undefined)?.map(({ SortBy }) => {
    const fields = (
      SortBy.node as { ColumnRef: { fields: Array<{ String: { sval: string } }> } }
    ).ColumnRef.fields.map((f) => f.String.sval);
    return `${fields.join(".")} ${SortBy.sortby_dir}`;
  });
const stripLocations = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(stripLocations)
    : typeof v === "object" && v !== null
      ? Object.fromEntries(
          Object.entries(v)
            .filter(([k]) => !/location$|_start$|_end$|_len$/.test(k))
            .map(([k, x]) => [k, stripLocations(x)]),
        )
      : v;

test("with a time field the cap keeps the newest rows, in the statement's own order", async () => {
  const cases: Array<{ name: string; sql: string; timeField: string }> = [
    { name: "plain", sql: "SELECT ts, status FROM http_requests", timeField: "ts" },
    {
      name: "aliased",
      sql: "SELECT date_trunc('minute', ts) AS bucket, count(*) AS n FROM http_requests GROUP BY bucket ORDER BY bucket",
      timeField: "bucket",
    },
    {
      name: "inside a CTE",
      sql: "WITH recent AS (SELECT ts, status FROM http_requests WHERE status >= 500) SELECT ts, status FROM recent",
      timeField: "ts",
    },
    {
      name: "with its own ORDER BY",
      sql: "SELECT ts, status FROM http_requests ORDER BY ts DESC, status",
      timeField: "ts",
    },
  ];
  for (const { name, sql, timeField } of cases) {
    const r = await validateSql(sql, source);
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    const plan = buildExecutablePlan({
      sql,
      timeField,
      from: new Date(0),
      to: new Date(1),
      rowFilter: null,
    });
    assert.equal(plan.ranked, true, name);
    assert.equal(plan.maxRows, config.maxQueryRows, name);
    const outer = stmtOf(plan.sql);
    // The survivors go back into the order the statement gave them.
    assert.deepEqual(sortKeys(outer), ["_holo_kept._holo_pos SORTBY_DEFAULT"], name);
    const cut = subOf(outer);
    assert.equal(cut.alias, "_holo_kept", name);
    // The cut is newest-first on the time field, at the cap.
    assert.deepEqual(
      sortKeys(cut.select),
      [`_holo.${timeField} SORTBY_DESC`, "_holo_pos SORTBY_DESC"],
      name,
    );
    assert.equal(
      (cut.select.limitCount as { A_Const: { ival: { ival: number } } }).A_Const.ival
        .ival,
      config.maxQueryRows,
      name,
    );
    // And what it cuts is exactly the statement that was checked.
    const holo = subOf(cut.select);
    assert.equal(holo.alias, "_holo", name);
    assert.deepEqual(stripLocations(holo.select), stripLocations(stmtOf(sql)), name);
  }
});

test("without a time field the cap keeps the first rows and asks for one more", async () => {
  const sql =
    "SELECT status, count(*) AS n FROM http_requests GROUP BY status ORDER BY n DESC";
  assert.equal((await validateSql(sql, source)).ok, true);
  const plan = buildExecutablePlan({
    sql,
    from: new Date(0),
    to: new Date(1),
    rowFilter: null,
  });
  assert.equal(plan.ranked, false);
  const outer = stmtOf(plan.sql);
  assert.equal(sortKeys(outer), undefined, "the statement's order is left alone");
  assert.equal(
    (outer.limitCount as { A_Const: { ival: { ival: number } } }).A_Const.ival.ival,
    config.maxQueryRows + 1,
  );
  assert.deepEqual(stripLocations(subOf(outer).select), stripLocations(stmtOf(sql)));
});

test("the wrapper's own check survives offsets that move and names Postgres folds", async () => {
  // Found by the fuzzer and the fixture snapshots (#486). An array literal
  // and an IN list keep their byte offsets under keys other than `location`,
  // which shift when the statement is embedded; and an unquoted time field is folded to lower case
  // in the parse tree, so `timeField: "A"` sorts on `_holo.a`.
  const sql =
    "SELECT ts AS A FROM http_requests WHERE status = ANY(ARRAY[200, 201]) AND status IN (200, 201)";
  assert.equal((await validateSql(sql, source)).ok, true);
  const plan = buildExecutablePlan({
    sql,
    timeField: "A",
    from: new Date(0),
    to: new Date(1),
    rowFilter: null,
  });
  assert.equal(plan.ranked, true);
});

test("a wrapper that is not the one the guard builds fails verification", () => {
  const inner = "SELECT ts, status FROM http_requests";
  const cap = 5;
  const good = `SELECT * FROM (SELECT _holo.*, row_number() OVER () AS _holo_pos, count(*) OVER () AS _holo_total
FROM (${inner}) AS _holo
WHERE _holo.ts >= $1::timestamptz AND _holo.ts < $2::timestamptz
ORDER BY _holo.ts DESC, _holo_pos DESC
LIMIT ${cap}) AS _holo_kept
ORDER BY _holo_kept._holo_pos`;
  verifyWrapper(good, inner, "ts", cap);
  const broken: Record<string, string> = {
    "oldest kept": good.replace("_holo.ts DESC", "_holo.ts ASC"),
    "another field": good.replace("ORDER BY _holo.ts DESC", "ORDER BY _holo.status DESC"),
    "a larger limit": good.replace(`LIMIT ${cap})`, `LIMIT ${cap * 10})`),
    "no limit": good.replace(`LIMIT ${cap})`, ")"),
    "no time filter": good.replace(/WHERE[^\n]*\n/, ""),
    "another statement": good.replace(
      inner,
      "SELECT ts, status FROM http_requests WHERE true",
    ),
    "two statements": `${good}; SELECT 1`,
  };
  for (const [name, sql] of Object.entries(broken)) {
    assert.throws(() => verifyWrapper(sql, inner, "ts", cap), /verification/, name);
  }
  const untimed = `SELECT * FROM (${inner}) AS _holo LIMIT ${cap + 1}`;
  verifyWrapper(untimed, inner, undefined, cap);
  assert.throws(
    () =>
      verifyWrapper(
        untimed.replace(`LIMIT ${cap + 1}`, "LIMIT ALL"),
        inner,
        undefined,
        cap,
      ),
    /verification/,
  );
  assert.throws(
    () =>
      verifyWrapper(
        `${untimed.replace(" LIMIT", " ORDER BY 1 LIMIT")}`,
        inner,
        undefined,
        cap,
      ),
    /verification/,
  );
});

test("a panel's own row limit goes inside the guard's cap, never above it", async () => {
  // #499: a "latest 50" panel is a 50-row query.
  const sql = "SELECT ts, status FROM http_requests";
  assert.equal((await validateSql(sql, source)).ok, true);
  const limitOf = (maxRows: number | undefined, timeField?: string) => {
    const plan = buildExecutablePlan({
      sql,
      timeField,
      from: new Date(0),
      to: new Date(1),
      rowFilter: null,
      maxRows,
    });
    return plan.maxRows;
  };
  assert.equal(limitOf(50, "ts"), 50);
  assert.match(
    buildExecutablePlan({
      sql,
      timeField: "ts",
      from: new Date(0),
      to: new Date(1),
      rowFilter: null,
      maxRows: 50,
    }).sql,
    /\bLIMIT 50\)/,
  );
  assert.equal(limitOf(50), 50);
  assert.equal(limitOf(config.maxQueryRows * 10, "ts"), config.maxQueryRows);
  for (const bad of [0, -1, 2.5, Number.NaN, undefined]) {
    assert.equal(limitOf(bad, "ts"), config.maxQueryRows, String(bad));
  }
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
      rowFilter: null,
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

test("a range that will not resolve throws TimeRangeError, not a bare Error", () => {
  // The type is the contract: the poller shows a TimeRangeError's message to
  // the viewer (the range is theirs to fix) and keeps everything else opaque.
  assert.throws(() => resolveTimeExpr("not-a-time"), TimeRangeError);
  assert.throws(() => resolveTimeRange({ from: "now", to: "now-1h" }), TimeRangeError);
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

test("an unexposed column is refused under its own reason", async () => {
  const restricted = TimescaleDbConfig.parse({
    ...source,
    tables: [
      {
        ...source.tables[0],
        columns: [
          ...source.tables[0].columns,
          { name: "client_ip", type: "inet", exposed: false },
        ],
      },
    ],
  });
  for (const sql of [
    "SELECT client_ip FROM http_requests",
    "SELECT * FROM http_requests",
    "SELECT r FROM http_requests r",
  ]) {
    const r = await validateSql(sql, restricted);
    assert.equal(r.ok, false, sql);
    assert.equal(r.reason, "column", `${sql} -> ${r.error}`);
  }
  const named = await validateSql("SELECT ts, status FROM http_requests", restricted);
  assert.equal(named.ok, true, named.error);
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
