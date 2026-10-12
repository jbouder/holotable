import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_TABLE_FUNCTIONS } from "@/lib/sql/denylist";
import { validateSql } from "@/lib/sql/safety";
import { TimescaleDbConfig } from "@/lib/registry";
import {
  DUCKDB_ACCEPTED,
  DUCKDB_FORBIDDEN_CALLS,
  DUCKDB_STATEMENTS,
} from "./fixtures/sql-fuzz-corpus";

/**
 * DuckDB's escape hatches (#571, phase 2 of #569).
 *
 * DuckDB parses with a fork of libpg_query, so the guard's PostgreSQL grammar
 * is its grammar too. What differs is how it reaches outside the database: a
 * table function or scalar function that reads a file (`read_csv`,
 * `read_parquet`, `glob`), fetches over the network (httpfs makes the readers
 * accept `s3://` and `https://`), executes a query string (`query`), reads the
 * environment (`getenv`) or lists the catalog (`duckdb_tables`); and a
 * statement that attaches, copies, loads or sets something. DuckDB has no
 * roles, so the guard is one of only two belts; the engine's locked
 * configuration is the other.
 *
 * The lists live in `test/fixtures/sql-fuzz-corpus.ts`, which also holds every
 * entry as a corpus case for the fuzz suite. Each gets a named test here.
 */

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

async function refusedFor(sql: string, reason: string, name: RegExp) {
  const r = await validateSql(sql, source);
  assert.equal(r.ok, false, `expected rejection, got ok for: ${sql}`);
  assert.equal(r.reason, reason, `${sql} -> ${r.error}`);
  assert.match(r.error ?? "", name, sql);
}

// --- Functions -------------------------------------------------------------------

for (const [name, args] of DUCKDB_FORBIDDEN_CALLS) {
  test(`refuses DuckDB's ${name}(), in the select list and in FROM`, async () => {
    const named = new RegExp(`\\b${name}\\(\\)`);
    await refusedFor(`SELECT ${name}${args} FROM http_requests`, "function", named);
    await refusedFor(`SELECT * FROM ${name}${args}`, "function", named);
    await refusedFor(`SELECT * FROM main.${name}${args} AS f`, "function", named);
  });
}

test("refuses DuckDB's clock readings and uuid()", async () => {
  for (const fn of [
    "get_current_timestamp",
    "get_current_time",
    "current_localtimestamp",
    "current_localtime",
    "uuid",
  ]) {
    await refusedFor(
      `SELECT ${fn}() FROM http_requests`,
      "time",
      new RegExp(`\\b${fn}\\(\\)`),
    );
  }
});

// --- Table functions in FROM -------------------------------------------------------

test("a table function in FROM is refused with a message that names it", async () => {
  await refusedFor(
    "SELECT * FROM generate_series(1, 3) g",
    "function",
    /table functions are not allowed in FROM: generate_series\(\)/,
  );
  await refusedFor(
    "SELECT * FROM range(10) r",
    "function",
    /not allowed in FROM: range\(\)/,
  );
  await refusedFor(
    "SELECT * FROM some_extension_scan('/data/x') s",
    "function",
    /not allowed in FROM: some_extension_scan\(\)/,
  );
});

test("a LATERAL or ROWS FROM table function is a table function in FROM", async () => {
  await refusedFor(
    "SELECT h.status FROM http_requests h, LATERAL unnest(ARRAY[h.status]) u",
    "function",
    /not allowed in FROM: unnest\(\)/,
  );
  await refusedFor(
    "SELECT * FROM ROWS FROM (generate_series(1, 2), generate_series(3, 4)) AS r(a, b)",
    "function",
    /not allowed in FROM: generate_series\(\)/,
  );
});

test("a FROM item that is an expression rather than a call is refused by its node", async () => {
  await refusedFor(
    "SELECT * FROM coalesce(1, 2) c",
    "function",
    /not allowed in FROM: CoalesceExpr/,
  );
  await refusedFor(
    "SELECT * FROM CAST('1' AS int) c",
    "function",
    /not allowed in FROM: TypeCast/,
  );
});

test("a table function is refused in FROM wherever the FROM is", async () => {
  for (const sql of [
    "WITH g AS (SELECT * FROM generate_series(1, 3) s) SELECT * FROM g",
    "SELECT * FROM (SELECT * FROM generate_series(1, 3) s) q",
    "SELECT status FROM http_requests WHERE status IN (SELECT * FROM generate_series(1, 3) s)",
    "SELECT status FROM http_requests UNION ALL SELECT * FROM generate_series(1, 3) s",
  ]) {
    await refusedFor(sql, "function", /not allowed in FROM: generate_series\(\)/);
  }
});

test("the table-function allowlist is empty", () => {
  // Adding generate_series (the one candidate) is a decision, with a test of
  // its own, not a side effect.
  assert.deepEqual([...ALLOWED_TABLE_FUNCTIONS], []);
});

// --- Statements --------------------------------------------------------------------

for (const [keyword, sql] of DUCKDB_STATEMENTS) {
  test(`refuses DuckDB's ${keyword}: ${sql}`, async () => {
    // Several of these are not PostgreSQL grammar and fail to parse; that is a
    // refusal too. The rule is the refusal, not the reason.
    const r = await validateSql(sql, source);
    assert.equal(r.ok, false, `expected rejection, got ok for: ${sql}`);
  });
}

// --- What a DuckDB prompt will teach ------------------------------------------------

test("accepts the time bucketing a DuckDB source's prompt will teach", async () => {
  for (const sql of DUCKDB_ACCEPTED) {
    const r = await validateSql(sql, source);
    assert.equal(r.ok, true, `expected acceptance, got "${r.error}" for: ${sql}`);
  }
});
