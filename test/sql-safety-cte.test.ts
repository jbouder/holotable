import { test } from "node:test";
import assert from "node:assert/strict";
import { validateSql } from "@/lib/sql/safety";
import { SourceConfig } from "@/lib/registry";

/**
 * Writes smuggled through data-modifying CTEs, and the shapes around them.
 *
 * PostgreSQL allows `WITH x AS (INSERT ... RETURNING *) SELECT * FROM x`, which
 * begins with `WITH` and so clears the `^(select|with)` gate in `validateSql`.
 * Nothing but the keyword denylist stands between that statement and the
 * database. These tests pin each construct by name so a refactor of the
 * denylist — or the AST validation in #10 that replaces it — names the exact
 * construct it broke rather than failing one lumped assertion.
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
      ],
    },
  ],
});

function rejects(sql: string) {
  const r = validateSql(sql, source);
  assert.equal(r.ok, false, `expected rejection, got ok for: ${sql}`);
  return r.error;
}

function accepts(sql: string) {
  const r = validateSql(sql, source);
  assert.equal(r.ok, true, `expected acceptance, got "${r.error}" for: ${sql}`);
}

test("rejects INSERT smuggled through a CTE", () => {
  rejects(
    "WITH x AS (INSERT INTO metrics.http_requests VALUES (1) RETURNING *) SELECT * FROM x",
  );
});

test("rejects UPDATE smuggled through a CTE", () => {
  rejects(
    "WITH x AS (UPDATE metrics.http_requests SET status = 1 RETURNING *) SELECT * FROM x",
  );
});

test("rejects DELETE smuggled through a CTE", () => {
  rejects("WITH x AS (DELETE FROM metrics.http_requests RETURNING *) SELECT * FROM x");
});

test("rejects a write inside WITH RECURSIVE", () => {
  rejects(
    "WITH RECURSIVE x AS (INSERT INTO metrics.http_requests VALUES (1) RETURNING *) SELECT * FROM x",
  );
});

test("rejects a write nested two CTE levels deep", () => {
  rejects(
    "WITH a AS (WITH b AS (INSERT INTO metrics.http_requests VALUES (1) RETURNING *) SELECT * FROM b) SELECT * FROM a",
  );
});

test("rejects MERGE and TRUNCATE smuggled through a CTE", () => {
  rejects("WITH x AS (TRUNCATE metrics.http_requests RETURNING *) SELECT * FROM x");
  rejects("WITH x AS (CREATE TABLE evil AS SELECT 1 RETURNING *) SELECT * FROM x");
});

test("positive control: a plain subquery is still accepted", () => {
  accepts("SELECT * FROM (SELECT 1) t");
});

test("positive control: a CTE over an allowlisted table is accepted", () => {
  accepts("WITH b AS (SELECT ts FROM http_requests) SELECT count(*) FROM http_requests");
});
