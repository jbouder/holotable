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

/**
 * DuckDB's file, network, query-string, environment and introspection
 * functions (#571), each with an argument list that parses. Every one is on
 * `FORBIDDEN_FUNCTIONS`; `test/sql-safety-duckdb.test.ts` names a refusal for
 * each, in the select list and in FROM, and the corpus below holds both.
 */
export const DUCKDB_FORBIDDEN_CALLS: ReadonlyArray<
  readonly [name: string, args: string]
> = [
  // Files.
  ["read_csv", "('/etc/passwd')"],
  ["read_csv_auto", "('/etc/passwd')"],
  ["read_parquet", "('/data/*.parquet')"],
  ["parquet_scan", "('/data/x.parquet')"],
  ["read_json", "('/data/x.json')"],
  ["read_json_auto", "('/data/x.json')"],
  ["read_json_objects", "('/data/x.json')"],
  ["read_json_objects_auto", "('/data/x.json')"],
  ["read_ndjson", "('/data/x.ndjson')"],
  ["read_ndjson_auto", "('/data/x.ndjson')"],
  ["read_ndjson_objects", "('/data/x.ndjson')"],
  ["read_text", "('/etc/passwd')"],
  ["read_blob", "('/etc/passwd')"],
  ["read_xlsx", "('/data/x.xlsx')"],
  ["glob", "('/*')"],
  ["sniff_csv", "('/etc/passwd')"],
  ["parquet_metadata", "('/data/x.parquet')"],
  ["parquet_file_metadata", "('/data/x.parquet')"],
  ["parquet_kv_metadata", "('/data/x.parquet')"],
  ["parquet_schema", "('/data/x.parquet')"],
  // The network and other engines.
  ["load_aws_credentials", "()"],
  ["iceberg_scan", "('s3://bucket/t')"],
  ["iceberg_metadata", "('s3://bucket/t')"],
  ["iceberg_snapshots", "('s3://bucket/t')"],
  ["delta_scan", "('s3://bucket/t')"],
  ["postgres_scan", "('host=x', 'public', 't')"],
  ["postgres_query", "('db', 'SELECT 1')"],
  ["postgres_attach", "('host=x')"],
  ["mysql_scan", "('host=x', 'd', 't')"],
  ["mysql_query", "('db', 'SELECT 1')"],
  ["sqlite_scan", "('/data/x.db', 't')"],
  ["sqlite_attach", "('/data/x.db')"],
  // Query strings.
  ["query", "('SELECT * FROM secret')"],
  ["query_table", "('secret')"],
  ["json_execute_serialized_sql", "('{}')"],
  // The environment, settings, variables and extensions.
  ["getenv", "('HOME')"],
  ["getvariable", "('x')"],
  ["current_setting", "('enable_external_access')"],
  ["duckdb_settings", "()"],
  ["duckdb_extensions", "()"],
  ["duckdb_databases", "()"],
  ["duckdb_secrets", "()"],
  ["which_secret", "('s3://bucket/x', 's3')"],
  ["load", "('httpfs')"],
  ["install", "('httpfs')"],
  // Catalog introspection.
  ["duckdb_tables", "()"],
  ["duckdb_columns", "()"],
  ["duckdb_views", "()"],
  ["duckdb_schemas", "()"],
  ["duckdb_functions", "()"],
  ["duckdb_temporary_files", "()"],
  ["pragma_table_info", "('secret')"],
  ["pragma_database_list", "()"],
  ["pragma_storage_info", "('secret')"],
  // Writes.
  ["checkpoint", "()"],
  ["force_checkpoint", "()"],
];

/**
 * DuckDB statements that are not a SELECT (#571). Several are not PostgreSQL
 * grammar at all and fail to parse, which is a refusal too; the tests assert
 * the refusal, not the reason.
 */
export const DUCKDB_STATEMENTS: ReadonlyArray<readonly [keyword: string, sql: string]> = [
  ["ATTACH", "ATTACH '/data/other.duckdb' AS other (READ_ONLY)"],
  ["DETACH", "DETACH other"],
  ["COPY", "COPY http_requests TO '/tmp/out.csv'"],
  ["COPY", "COPY (SELECT * FROM http_requests) TO '/tmp/out.parquet' (FORMAT parquet)"],
  ["EXPORT", "EXPORT DATABASE '/tmp/dump'"],
  ["IMPORT", "IMPORT DATABASE '/tmp/dump'"],
  ["INSTALL", "INSTALL httpfs"],
  ["LOAD", "LOAD httpfs"],
  ["SET", "SET enable_external_access = true"],
  ["SET", "SET VARIABLE x = 1"],
  ["PRAGMA", "PRAGMA database_list"],
  ["CALL", "CALL duckdb_settings()"],
];

/**
 * SQL a DuckDB source's prompt will teach (#569): time bucketing through
 * `date_trunc`, `time_bucket` and `date_bin` with a literal origin. Accepted
 * on every SQL kind, since the grammar is the same.
 */
export const DUCKDB_ACCEPTED: readonly string[] = [
  "SELECT date_trunc('hour', ts) AS t, count(*) AS c FROM http_requests GROUP BY 1 ORDER BY 1",
  "SELECT time_bucket(interval '5 minutes', ts) AS t, avg(duration_ms) FROM http_requests GROUP BY t ORDER BY t",
  "SELECT date_bin(interval '15 minutes', ts, TIMESTAMP '2000-01-01') AS t, count(*) FROM http_requests GROUP BY t",
  "SELECT date_bin('1 hour', ts, timestamptz '2000-01-01 00:00:00+00') AS t, max(duration_ms) FROM http_requests GROUP BY 1",
  "WITH b AS (SELECT date_trunc('day', ts) AS d, status FROM http_requests) SELECT d, count(*) FILTER (WHERE status >= 500) FROM b GROUP BY d",
];

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
  // --- DuckDB's escapes (#571) ---------------------------------------------------
  ...DUCKDB_FORBIDDEN_CALLS.flatMap(([name, args]): CorpusEntry[] => [
    {
      sql: `SELECT ${name}${args} FROM http_requests`,
      verdict: "reject",
      note: `DuckDB's ${name}() in the select list`,
    },
    {
      sql: `SELECT * FROM ${name}${args}`,
      verdict: "reject",
      note: `DuckDB's ${name}() as a table function`,
    },
  ]),
  ...DUCKDB_STATEMENTS.map(
    ([keyword, sql]): CorpusEntry => ({
      sql,
      verdict: "reject",
      note: `DuckDB's ${keyword} is not a SELECT`,
    }),
  ),
  {
    sql: "SELECT * FROM generate_series(1, 3) g",
    verdict: "reject",
    note: "a table function in FROM is refused unless allowlisted, and the allowlist is empty",
  },
  {
    sql: "SELECT h.status FROM http_requests h, LATERAL unnest(ARRAY[h.status]) u",
    verdict: "reject",
    note: "a LATERAL table function is a table function in FROM",
  },
  {
    sql: "SELECT * FROM ROWS FROM (generate_series(1, 2), generate_series(3, 4)) AS r(a, b)",
    verdict: "reject",
    note: "each function in ROWS FROM is a table function in FROM",
  },
  ...DUCKDB_ACCEPTED.map(
    (sql): CorpusEntry => ({
      sql,
      verdict: "accept",
      note: "DuckDB-flavored time bucketing the prompt will teach",
    }),
  ),
];
