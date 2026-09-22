import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceConfig, sourceCatalog } from "@/lib/registry";
import {
  selectOutputs,
  sqlHints,
  timeFieldCandidates,
  timeFieldWarning,
} from "@/lib/sql/hints";
import { validateSql } from "@/lib/sql/safety";
import { CORPUS } from "./fixtures/sql-fuzz-corpus";

/**
 * The editor's hint layer, and the one property that matters about it: it may
 * be quiet about a statement the guard refuses, but it may never speak about
 * one the guard accepts. Everything else here is a named case for a rule.
 */

const config = SourceConfig.parse({
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
        { name: "route", type: "text" },
        { name: "status", type: "smallint" },
        { name: "duration_ms", type: "double precision" },
      ],
    },
    {
      name: "cpu_usage",
      columns: [
        { name: "sampled_at", type: "timestamp without time zone" },
        { name: "host", type: "text" },
        { name: "pct", type: "double precision" },
      ],
    },
  ],
});
const catalog = sourceCatalog(config);

const messages = (sql: string) => sqlHints(sql, catalog).map((h) => h.message);

// --- The rules -------------------------------------------------------------------

test("a comment is flagged wherever it appears", () => {
  assert.deepEqual(messages("SELECT 1 FROM http_requests -- why"), [
    "comments are not allowed",
  ]);
  assert.deepEqual(messages("SELECT /* x */ 1 FROM http_requests"), [
    "comments are not allowed",
  ]);
});

test("a comment inside a string literal is not a comment", () => {
  assert.deepEqual(messages("SELECT 'a--b' FROM http_requests"), []);
  assert.deepEqual(messages("SELECT $q$/* not a comment */$q$ FROM http_requests"), []);
});

test("a second statement is flagged; trailing terminators are not", () => {
  assert.deepEqual(messages("SELECT 1 FROM http_requests; SELECT 2"), [
    "multiple statements are not allowed",
  ]);
  assert.deepEqual(messages("SELECT 1 FROM http_requests;"), []);
  assert.deepEqual(messages("SELECT 1 FROM http_requests ; ;\n"), []);
});

test("a statement that is plainly not a SELECT is flagged", () => {
  assert.deepEqual(messages("DELETE FROM http_requests"), [
    "only SELECT/WITH queries are allowed",
  ]);
  // VALUES and TABLE are SelectStmt to PostgreSQL, so the guard may accept
  // them; the hint layer stays out of it.
  assert.deepEqual(messages("VALUES (1)"), []);
});

test("a table outside the allowlist is flagged, bare or qualified", () => {
  assert.deepEqual(messages("SELECT * FROM secrets"), [
    "table not in catalog allowlist: secrets",
  ]);
  assert.deepEqual(messages("SELECT * FROM public.http_requests"), [
    "table not in catalog allowlist: public.http_requests",
  ]);
  assert.deepEqual(messages("SELECT * FROM metrics.http_requests"), []);
  assert.deepEqual(messages("SELECT * FROM http_requests JOIN cpu_usage ON true"), []);
});

test("case folding follows PostgreSQL: unquoted folds, quoted does not", () => {
  assert.deepEqual(messages("SELECT * FROM HTTP_REQUESTS"), []);
  assert.deepEqual(messages('SELECT * FROM "HTTP_REQUESTS"'), [
    "table not in catalog allowlist: HTTP_REQUESTS",
  ]);
});

test("a CTE name is not a missing table", () => {
  assert.deepEqual(
    messages("WITH recent AS (SELECT * FROM http_requests) SELECT * FROM recent"),
    [],
  );
});

test("FROM inside a function call is not a FROM clause", () => {
  // The false alarm this layer exists to avoid: `ts` is not a table.
  assert.deepEqual(messages("SELECT extract(epoch FROM ts) FROM http_requests"), []);
  assert.deepEqual(
    messages("SELECT substring(route FROM 1 FOR 3) FROM http_requests"),
    [],
  );
  assert.deepEqual(messages("SELECT * FROM (SELECT * FROM http_requests) t"), []);
  assert.deepEqual(messages("SELECT * FROM (SELECT * FROM secrets) t"), [
    "table not in catalog allowlist: secrets",
  ]);
});

test("a set-returning function in FROM is not a table", () => {
  assert.deepEqual(messages("SELECT * FROM generate_series(1, 10)"), []);
});

test("the guard's function denylists are flagged by name", () => {
  assert.deepEqual(messages("SELECT pg_sleep(1) FROM http_requests"), [
    "disallowed table function: pg_sleep()",
  ]);
  assert.deepEqual(messages("SELECT now() FROM http_requests"), [
    `disallowed function now(): the server owns the time range, and a spec must produce the same query on every tick`,
  ]);
});

test("a clock-reading keyword is flagged, but a column of the same name is not", () => {
  assert.deepEqual(messages("SELECT * FROM http_requests WHERE ts > current_timestamp"), [
    "disallowed keyword: current_timestamp",
  ]);
  assert.deepEqual(messages("SELECT t.current_date FROM http_requests t"), []);
});

test("a time word as a literal is flagged", () => {
  assert.deepEqual(messages("SELECT * FROM http_requests WHERE ts > 'now'"), [
    "disallowed time literal 'now': the server owns the time range, and a spec must produce the same query on every tick",
  ]);
});

test("hints carry the offsets of the text that provoked them", () => {
  const sql = "SELECT * FROM secrets";
  const [hint] = sqlHints(sql, catalog);
  assert.equal(sql.slice(hint.from, hint.to), "secrets");
});

test("without a catalog, the catalog rule is silent and the rest still runs", () => {
  assert.deepEqual(
    sqlHints("SELECT * FROM secrets -- x", null).map((h) => h.message),
    ["comments are not allowed"],
  );
});

// --- Output columns --------------------------------------------------------------

test("output columns are read off the select list", () => {
  assert.deepEqual(
    selectOutputs(
      "SELECT time_bucket('1m', ts) AS bucket, count(*) AS value FROM http_requests",
    ),
    { columns: ["bucket", "value"], complete: true },
  );
  assert.deepEqual(selectOutputs("SELECT ts, t.route FROM http_requests t"), {
    columns: ["ts", "route"],
    complete: true,
  });
  assert.deepEqual(selectOutputs("SELECT count(*) FROM http_requests"), {
    columns: ["count"],
    complete: true,
  });
  assert.deepEqual(selectOutputs("SELECT ts::date FROM http_requests"), {
    columns: ["ts"],
    complete: true,
  });
  assert.deepEqual(selectOutputs('SELECT ts AS "Bucket" FROM http_requests'), {
    columns: ["Bucket"],
    complete: true,
  });
});

test("an output list that cannot be read is incomplete, not guessed", () => {
  assert.equal(selectOutputs("SELECT * FROM http_requests").complete, false);
  assert.equal(
    selectOutputs("SELECT ts, duration_ms * 2 FROM http_requests").complete,
    false,
  );
  assert.equal(
    selectOutputs("SELECT DISTINCT ON (route) ts FROM http_requests").complete,
    false,
  );
});

test("a cast inside a call does not swallow the alias", () => {
  assert.deepEqual(
    selectOutputs("SELECT count(status::int) AS errors FROM http_requests"),
    { columns: ["errors"], complete: true },
  );
});

test("timeField candidates lead with the query's own output columns", () => {
  assert.deepEqual(
    timeFieldCandidates(
      "SELECT time_bucket('1m', ts) AS bucket, count(*) AS value FROM http_requests",
      catalog,
    ),
    ["bucket", "value", "ts", "sampled_at"],
  );
  // With `SELECT *` the catalog's timestamp columns are the output columns.
  assert.deepEqual(timeFieldCandidates("SELECT * FROM http_requests", catalog), [
    "ts",
    "sampled_at",
  ]);
});

test("a timeField the query does not return is warned about", () => {
  const outputs = selectOutputs(
    "SELECT time_bucket('1m', ts) AS bucket FROM http_requests",
  );
  assert.match(
    timeFieldWarning("ts", outputs) ?? "",
    /does not return a column called "ts"/,
  );
  assert.equal(timeFieldWarning("bucket", outputs), null);
  assert.equal(timeFieldWarning(undefined, outputs), null);
});

test("a timeField the server could not filter on at all is warned about", () => {
  const outputs = selectOutputs("SELECT * FROM http_requests");
  assert.match(timeFieldWarning("ts; DROP", outputs) ?? "", /not a plain column name/);
});

test("no warning while the output list is unknown", () => {
  assert.equal(
    timeFieldWarning("ts", selectOutputs("SELECT * FROM http_requests")),
    null,
  );
});

// --- The property ----------------------------------------------------------------

/**
 * Nothing the hint layer convicts may be something the guard accepts.
 *
 * The corpus is the fuzz suite's pinned set of adversarial statements, so this
 * runs the hints over exactly the shapes that have caught the guard out before.
 * A failure here means the editor is about to underline valid SQL.
 */
test("a hinted statement is always one the guard rejects", async () => {
  const accepted: string[] = [
    "SELECT ts, count(*) AS c FROM http_requests GROUP BY ts",
    "SELECT count(*) FROM metrics.http_requests",
    "WITH one AS (SELECT 1) SELECT count(*) FROM http_requests",
    "SELECT extract(epoch FROM ts) AS secs FROM http_requests",
    "SELECT 'a--b' AS s FROM http_requests",
    "SELECT * FROM http_requests JOIN cpu_usage ON true",
    "SELECT * FROM ONLY http_requests",
    "SELECT r.route FROM http_requests AS r WHERE r.status >= 500",
    "SELECT string_agg(route, ',' ORDER BY ts) AS routes FROM http_requests",
  ];
  for (const entry of CORPUS) {
    if (entry.verdict === "accept") accepted.push(entry.sql);
  }
  for (const sql of accepted) {
    const check = await validateSql(sql, config);
    assert.equal(check.ok, true, `fixture is not actually accepted: ${sql}`);
    assert.deepEqual(
      sqlHints(sql, catalog).map((h) => h.message),
      [],
      `the editor would underline a statement the guard accepts: ${sql}`,
    );
  }
});

test("every hint on the corpus names a statement the guard does reject", async () => {
  for (const entry of CORPUS) {
    if (sqlHints(entry.sql, catalog).length === 0) continue;
    const check = await validateSql(entry.sql, config);
    assert.equal(check.ok, false, `hinted but accepted: ${entry.sql}`);
  }
});
