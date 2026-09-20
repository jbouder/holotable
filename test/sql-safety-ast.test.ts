import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSql } from "@/lib/sql/safety";
import { analyzeSelect } from "@/lib/sql/ast";
import { SourceConfig } from "@/lib/registry";

/**
 * What the parse-tree validator sees that a regex could not.
 *
 * `validateSql` parses every statement with the real PostgreSQL grammar and
 * walks the tree (`src/lib/sql/ast.ts`). These tests pin the properties that
 * only a parser can give: table references collected from every position in
 * the tree, CTE names resolved with PostgreSQL's own scoping rules, literals
 * and identifiers read the way the server reads them, and a fail-closed answer
 * for anything the grammar does not recognise.
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
        { name: "route", type: "text" },
      ],
    },
  ],
});

async function rejects(sql: string, pattern?: RegExp) {
  const r = await validateSql(sql, source);
  assert.equal(r.ok, false, `expected rejection, got ok for: ${sql}`);
  if (pattern) assert.match(r.error ?? "", pattern, sql);
  return r.error;
}

async function accepts(sql: string) {
  const r = await validateSql(sql, source);
  assert.equal(r.ok, true, `expected acceptance, got "${r.error}" for: ${sql}`);
}

// --- Table references are collected from the whole tree ----------------------

test("a table hidden in a nested CTE is checked against the allowlist", async () => {
  await rejects(
    "WITH a AS (WITH b AS (SELECT 1 FROM secret) SELECT * FROM b) SELECT * FROM a",
    /allowlist: secret/,
  );
  await accepts(
    "WITH a AS (WITH b AS (SELECT ts FROM http_requests) SELECT * FROM b) SELECT * FROM a",
  );
});

test("a table in a lateral subquery is checked against the allowlist", async () => {
  await rejects(
    "SELECT * FROM http_requests h, LATERAL (SELECT 1 FROM secret s WHERE s.id = h.status) x",
    /allowlist: secret/,
  );
  await accepts(
    "SELECT * FROM http_requests h, LATERAL (SELECT 1 FROM http_requests i WHERE i.ts = h.ts) x",
  );
});

test("a table anywhere an expression can appear is checked", async () => {
  for (const sql of [
    "SELECT (SELECT max(x) FROM secret) FROM http_requests",
    "SELECT * FROM http_requests WHERE status IN (SELECT id FROM secret)",
    "SELECT * FROM http_requests WHERE EXISTS (SELECT 1 FROM secret)",
    "SELECT * FROM http_requests ORDER BY (SELECT max(id) FROM secret)",
    "SELECT * FROM http_requests LIMIT (SELECT count(*) FROM secret)",
    "SELECT count(*) FROM http_requests HAVING (SELECT true FROM secret)",
    "SELECT array(SELECT id FROM secret) FROM http_requests",
    "SELECT 1 FROM http_requests WINDOW w AS (ORDER BY (SELECT 1 FROM secret))",
    "SELECT * FROM http_requests h CROSS JOIN secret",
    "SELECT * FROM http_requests h NATURAL JOIN secret",
  ]) {
    await rejects(sql, /allowlist: secret/);
  }
});

test("every arm of a set operation is checked", async () => {
  await rejects(
    "SELECT 1 FROM http_requests UNION SELECT 2 FROM secret",
    /allowlist: secret/,
  );
  await rejects(
    "SELECT 1 FROM secret INTERSECT SELECT 2 FROM http_requests",
    /allowlist/,
  );
  await rejects(
    "(WITH s AS (SELECT 1 FROM secret) SELECT * FROM s) UNION SELECT 1",
    /allowlist/,
  );
  await accepts("SELECT 1 FROM http_requests UNION ALL SELECT 2 FROM http_requests");
});

test("TABLE and VALUES are SELECTs and are checked like one", async () => {
  await rejects("TABLE secret", /allowlist: secret/);
  await accepts("TABLE http_requests");
  await accepts("SELECT * FROM (VALUES (1), (2)) v(x)");
});

test("a three-part table name is rejected", async () => {
  await rejects(
    "SELECT * FROM holotable.metrics.http_requests",
    /invalid table reference/,
  );
});

// --- CTE scoping follows PostgreSQL --------------------------------------------

test("a CTE name is visible to the statement body and to later CTEs", async () => {
  await accepts("WITH s AS (SELECT ts FROM http_requests) SELECT * FROM s");
  await accepts("WITH s AS (SELECT 1), t AS (SELECT * FROM s) SELECT * FROM t");
  await accepts(
    "WITH s AS (SELECT 1) SELECT * FROM http_requests WHERE ts IN (SELECT 1 FROM s)",
  );
  await accepts("SELECT * FROM (WITH s AS (SELECT 1) SELECT * FROM s) t");
});

test("a CTE name defined in a subquery is not visible outside it", async () => {
  // The outer `secret` here is the real table: the CTE's scope ends at the
  // closing parenthesis. Treating every CTE name as global would let this through.
  await rejects(
    "SELECT * FROM (WITH secret AS (SELECT 1) SELECT 1) t, secret",
    /allowlist: secret/,
  );
  await rejects(
    "SELECT * FROM http_requests WHERE ts IN (WITH secret AS (SELECT 1) SELECT 1) AND status IN (SELECT id FROM secret)",
    /allowlist: secret/,
  );
});

test("without RECURSIVE a CTE cannot see a later CTE, so that name is a real table", async () => {
  await rejects(
    "WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a",
    /allowlist: b/,
  );
  await rejects("WITH t AS (SELECT * FROM t) SELECT * FROM t", /allowlist: t/);
});

test("with RECURSIVE every CTE name is in scope for every body", async () => {
  await accepts("WITH RECURSIVE a AS (SELECT * FROM b), b AS (SELECT 1) SELECT * FROM a");
  await accepts(
    "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 5) SELECT n FROM t",
  );
});

test("a schema-qualified name is never a CTE", async () => {
  await rejects("WITH s AS (SELECT 1) SELECT * FROM metrics.s", /allowlist: metrics\.s/);
});

test("a CTE that shadows an allowlisted table still has its body checked", async () => {
  await rejects(
    "WITH http_requests AS (SELECT 1 FROM secret) SELECT * FROM http_requests",
    /allowlist: secret/,
  );
});

// --- The parser reads literals and identifiers the way the server does ---------

test("a dollar-quoted literal containing DDL is a string", async () => {
  await accepts("SELECT $tag$ DROP TABLE http_requests $tag$ FROM http_requests");
  await accepts("SELECT $$;--$$ FROM http_requests");
});

test("a unicode-escaped identifier resolves to the table it names", async () => {
  // U&"\0068ttp_requests" is `http_requests`; U&"\0073ecret" is `secret`.
  await accepts('SELECT ts FROM U&"\\0068ttp_requests"');
  await rejects('SELECT * FROM U&"\\0073ecret"', /allowlist: secret/);
});

test("a quoted or differently-cased reference is compared as the server resolves it", async () => {
  // Unquoted identifiers fold to lowercase, whatever the case they were written in.
  await accepts("SELECT * FROM Http_Requests");
  await accepts("SELECT * FROM HTTP_REQUESTS");
  await accepts("SELECT * FROM METRICS.HTTP_REQUESTS");
  // A quoted identifier keeps its case, so it must match the catalog exactly.
  await accepts('SELECT * FROM "http_requests"');
  await accepts('SELECT * FROM "metrics"."http_requests"');
});

test("a quoted identifier that differs from the catalog only by case is a different table", async () => {
  // PostgreSQL would look up a relation literally named HTTP_REQUESTS, which
  // the catalog does not declare. Lowercasing before the comparison let it
  // through as http_requests.
  await rejects('SELECT * FROM "HTTP_REQUESTS"', /allowlist: HTTP_REQUESTS/);
  await rejects('SELECT * FROM "Http_Requests"', /allowlist: Http_Requests/);
  await rejects(
    'SELECT * FROM metrics."HTTP_REQUESTS"',
    /allowlist: metrics\.HTTP_REQUESTS/,
  );
  await rejects(
    'SELECT * FROM "METRICS".http_requests',
    /allowlist: METRICS\.http_requests/,
  );
  await rejects('SELECT ts FROM U&"\\0048TTP_REQUESTS"', /allowlist: HTTP_REQUESTS/);
});

test("a mixed-case catalog table is reachable only by its exact quoted name", async () => {
  const mixed = SourceConfig.parse({
    ...source,
    tables: [
      {
        name: "CpuUsage",
        timeField: "ts",
        columns: [{ name: "ts", type: "timestamp with time zone" }],
      },
    ],
  });
  const ok = await validateSql('SELECT * FROM "CpuUsage"', mixed);
  assert.equal(ok.ok, true, ok.error);
  const qualified = await validateSql('SELECT * FROM metrics."CpuUsage"', mixed);
  assert.equal(qualified.ok, true, qualified.error);
  // Unquoted, the server folds this to cpuusage, which is not the table.
  for (const sql of [
    "SELECT * FROM CpuUsage",
    "SELECT * FROM cpuusage",
    'SELECT * FROM "cpuusage"',
    'SELECT * FROM "CPUUSAGE"',
  ]) {
    const r = await validateSql(sql, mixed);
    assert.equal(r.ok, false, `expected rejection for: ${sql}`);
    assert.match(r.error ?? "", /table not in catalog allowlist/, sql);
  }
});

test("a semicolon or comment marker inside a literal is not a statement boundary or comment", async () => {
  await accepts("SELECT ';' FROM http_requests");
  await accepts("SELECT '--' FROM http_requests");
  await accepts("SELECT '/* x */' FROM http_requests");
});

// --- Set-returning functions in FROM ------------------------------------------

test("a set-returning function in FROM is allowed when the function is", async () => {
  await accepts("SELECT * FROM generate_series(1, 3) g");
  await accepts("SELECT * FROM http_requests h, generate_series(1, 2) g(n)");
  await accepts("SELECT * FROM unnest(ARRAY[1, 2]) WITH ORDINALITY");
});

test("a forbidden function is caught in FROM, qualified or not", async () => {
  await rejects("SELECT * FROM pg_read_file('/etc/passwd')", /pg_read_file/);
  await rejects("SELECT * FROM pg_catalog.pg_read_file('/etc/passwd')", /pg_read_file/);
  await rejects("SELECT * FROM pg_ls_dir('/') d", /pg_ls_dir/);
  await rejects("SELECT pg_catalog.pg_sleep(1) FROM http_requests", /pg_sleep/);
});

// --- Fail closed ---------------------------------------------------------------

test("a statement the parser cannot parse is rejected", async () => {
  await rejects("SELECT 1 FROM http_requests WHERE", /only SELECT\/WITH/);
  await rejects("SELEKT 1", /only SELECT\/WITH/);
  await rejects("SELECT 'unterminated", /only SELECT\/WITH/);
});

test("non-SELECT statements are rejected by type, not by keyword", async () => {
  for (const sql of [
    "EXPLAIN SELECT 1 FROM http_requests",
    "SHOW search_path",
    "SET search_path TO public",
    "COPY (SELECT 1) TO STDOUT",
    "PREPARE p AS SELECT 1",
    "DECLARE c CURSOR FOR SELECT 1",
    "MERGE INTO http_requests USING (SELECT 1) s ON true WHEN MATCHED THEN DELETE",
    "LOCK TABLE http_requests",
    "CREATE TABLE t AS SELECT 1",
  ]) {
    await rejects(sql, /only SELECT\/WITH/);
  }
});

test("SELECT INTO and row locking are rejected", async () => {
  await rejects("SELECT 1 INTO newt FROM http_requests", /into/);
  await rejects("SELECT 1 INTO TEMP newt FROM http_requests", /into/);
  await rejects("SELECT 1 INTO newt FROM http_requests UNION SELECT 2", /into/);
  await rejects("SELECT 1 FROM http_requests FOR UPDATE", /locking/);
  await rejects("SELECT 1 FROM http_requests FOR SHARE SKIP LOCKED", /locking/);
  await rejects("SELECT (SELECT 1 FROM http_requests FOR UPDATE)", /locking/);
});

test("a construct outside the allowlist is rejected by name", async () => {
  await rejects(
    "SELECT ts FROM http_requests WHERE ts = DEFAULT",
    /unsupported SQL construct: SetToDefault/,
  );
  await rejects("SELECT MERGE_ACTION() FROM http_requests", /unsupported SQL construct/);
});

test("the SQL date/time input words are time values, not strings", async () => {
  // PostgreSQL evaluates `'now'::timestamptz` — and `WHERE ts > 'now'`, by
  // implicit coercion — to the current time, with no function call to deny.
  await rejects("SELECT 'now'::timestamptz FROM http_requests", /time literal/);
  await rejects("SELECT * FROM http_requests WHERE ts > 'yesterday'", /time literal/);
  await rejects("SELECT timestamp 'today' FROM http_requests", /time literal/);
  await rejects("SELECT * FROM http_requests WHERE ts > ' NOW '", /time literal/);
  await accepts(
    "SELECT 'epoch'::timestamptz, 'infinity'::timestamptz FROM http_requests",
  );
});

test("parenless value keywords are rejected wherever they appear", async () => {
  await rejects(
    "SELECT * FROM http_requests WHERE ts > (SELECT current_timestamp)",
    /current_timestamp/,
  );
  await rejects("SELECT current_timestamp(3) FROM http_requests", /current_timestamp/);
  await rejects("SELECT user FROM http_requests", /disallowed keyword: user/);
});

test("side-effecting functions callable from a read-only transaction are rejected", async () => {
  for (const call of [
    "pg_advisory_lock(1)",
    "pg_try_advisory_xact_lock(1)",
    "pg_terminate_backend(1)",
    "pg_cancel_backend(1)",
    "pg_notify('a', 'b')",
    "pg_logical_emit_message(true, 'a', 'b')",
    "nextval('s')",
    "setval('s', 1)",
  ]) {
    await rejects(`SELECT ${call} FROM http_requests`);
  }
});

// --- The analysis itself ---------------------------------------------------------

test("analyzeSelect reports relations with CTE names resolved away", async () => {
  const r = await analyzeSelect(
    "WITH b AS (SELECT ts FROM metrics.http_requests) SELECT count(*) FROM b, other o",
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(r.analysis.tables, [
      { schema: "metrics", name: "http_requests" },
      { schema: undefined, name: "other" },
    ]);
    assert.deepEqual(
      r.analysis.functions.map((f) => f.name),
      ["count"],
    );
  }
});

test("analyzeSelect reports SQL-syntax functions by their real name", async () => {
  const r = await analyzeSelect(
    "SELECT extract(epoch FROM ts), ts AT TIME ZONE 'UTC' FROM t",
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.deepEqual(
      r.analysis.functions.map((f) => f.path),
      [
        ["pg_catalog", "extract"],
        ["pg_catalog", "timezone"],
      ],
    );
    assert.deepEqual(r.analysis.strings, ["epoch", "UTC"]);
  }
});
