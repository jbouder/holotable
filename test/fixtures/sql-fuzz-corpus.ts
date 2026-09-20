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
];
