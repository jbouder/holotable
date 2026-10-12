/**
 * Seed corpus for `test/sql-safety.fuzz.test.ts`.
 *
 * Every entry runs on every test run, before the generated cases, so a shape
 * the fuzzer once found stays covered even when the generators change. When
 * the fuzzer reports a counterexample, paste its exact `sql` here with the
 * verdict it *should* have, and add a named case to `test/sql-safety.test.ts`
 * (or the file that owns that rule) explaining why.
 *
 * `verdict: "accept"` entries are also wrapped by `buildExecutablePlan` and the
 * result must still parse as one SELECT.
 */
export interface CorpusEntry {
  sql: string;
  verdict: "accept" | "reject";
  /** What this entry pins, for the failure message. */
  note: string;
}

export const CORPUS: CorpusEntry[] = [
  // --- Found by fuzzing --------------------------------------------------------
  {
    sql: "SELECT 1 FROM http_requests;;",
    verdict: "accept",
    note: "found by the plan-wrapping property: only one trailing `;` was stripped, so the wrapped plan `SELECT * FROM (SELECT 1 FROM http_requests;) AS _holo …` did not parse",
  },
  {
    sql: "SELECT 1 FROM http_requests ; ;\n",
    verdict: "accept",
    note: "as above, with whitespace between the terminators",
  },
  {
    sql: "SELECT ts FROM http_requests WHERE status = ANY(ARRAY[200, 201])",
    verdict: "accept",
    note: "found by the plan-wrapping property (#486): an array literal records its byte offsets as `list_start`/`list_end`, which move when the statement is wrapped, so the wrapper's check that it holds the checked statement must ignore them",
  },
  {
    sql: "SELECT ts FROM http_requests WHERE status IN (200, 201)",
    verdict: "accept",
    note: "found by the IR fixture snapshots (#486): an IN list keeps its offsets as `rexpr_list_start`/`rexpr_list_end`",
  },

  // --- Seeds: one representative per adversarial class ----------------------------
  {
    sql: "SELECT 'to'\n'day'::timestamptz FROM http_requests",
    verdict: "reject",
    note: "adjacent string literals separated by a newline are concatenated by the lexer into the time word 'today'",
  },
  {
    sql: "SELECT U&'\\006eow'::timestamptz FROM http_requests",
    verdict: "reject",
    note: "unicode-escaped literal decoding to 'now'",
  },
  {
    sql: "SELECT $q$today$q$::date FROM http_requests",
    verdict: "reject",
    note: "tagged dollar-quoted time word",
  },
  {
    sql: 'SELECT U&"pg_\\0073leep"(1) FROM http_requests',
    verdict: "reject",
    note: "unicode-escaped function identifier",
  },
  {
    sql: "SELECT 1 FROM http_requests ORDER BY (SELECT pg_sleep(1))",
    verdict: "reject",
    note: "forbidden call hidden in an ORDER BY subquery",
  },
  {
    sql: "WITH a AS (SELECT * FROM b), b AS (SELECT 1 FROM http_requests) SELECT * FROM a",
    verdict: "reject",
    note: "without RECURSIVE, `b` inside `a` is a real table, not the later CTE",
  },
  {
    sql: "WITH secret AS (SELECT * FROM secret) SELECT * FROM secret",
    verdict: "reject",
    note: "a non-recursive CTE cannot see itself; the body reads the real table",
  },
  {
    sql: "WITH RECURSIVE secret AS (SELECT 1) SELECT * FROM secret",
    verdict: "accept",
    note: "a CTE may shadow a forbidden name; the body reads nothing",
  },
  {
    sql: "SELECT 1 FROM http_requests LIMIT (SELECT count(*) FROM pg_catalog.pg_shadow)",
    verdict: "reject",
    note: "allowlist checked in a LIMIT subquery",
  },
  {
    sql: 'SELECT * FROM "http_requests "',
    verdict: "reject",
    note: "a quoted identifier with a trailing space is a different relation",
  },
  {
    sql: 'SELECT * FROM "HTTP_REQUESTS"',
    verdict: "reject",
    note: "a quoted identifier keeps its case, so this names a relation the catalog does not declare (#151)",
  },
  {
    sql: 'SELECT * FROM metrics."Http_Requests"',
    verdict: "reject",
    note: "as above, schema-qualified",
  },
  {
    sql: 'SELECT * FROM "METRICS".http_requests',
    verdict: "reject",
    note: "the schema part is compared the same way",
  },
  {
    sql: "SELECT * FROM METRICS.HTTP_REQUESTS",
    verdict: "accept",
    note: "unquoted identifiers fold to lowercase whatever their case",
  },
  {
    sql: "SELECT 1 /* a /* nested */ b */ FROM http_requests",
    verdict: "reject",
    note: "PostgreSQL block comments nest",
  },
  {
    sql: "SELECT $$ -- not a comment; DROP TABLE http_requests $$ FROM http_requests",
    verdict: "accept",
    note: "comment and statement markers inside a dollar-quoted string are text",
  },
  {
    sql: "WITH x AS (DELETE FROM http_requests RETURNING *) SELECT * FROM x",
    verdict: "reject",
    note: "data-modifying CTE",
  },
  {
    sql: "SELECT 1 FROM http_requests WHERE status = $1",
    verdict: "reject",
    note: "positional parameters are reserved for the server's time bounds",
  },
  {
    sql: "SELECT CURRENT_TIMESTAMP (3) FROM http_requests",
    verdict: "reject",
    note: "value keyword with a precision argument",
  },

  // --- Plain PostgreSQL bucketing (#557) ------------------------------------------
  {
    sql: "SELECT date_bin('5 minutes', ts, TIMESTAMP '2000-01-01') AS bucket, count(*) AS n FROM http_requests GROUP BY 1 ORDER BY 1",
    verdict: "accept",
    note: "a plain PostgreSQL source is told to bucket with date_bin: its origin is a constant timestamp literal, which is not a time word and must pass",
  },
  {
    sql: "SELECT date_bin('5 minutes', ts, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket, avg(duration_ms) FROM http_requests GROUP BY 1",
    verdict: "accept",
    note: "as above, with a timestamptz origin",
  },
  {
    sql: "SELECT date_bin('5 minutes', ts, TIMESTAMP 'today') AS bucket FROM http_requests",
    verdict: "reject",
    note: "the origin is still a literal like any other: a time word there is refused",
  },
];
