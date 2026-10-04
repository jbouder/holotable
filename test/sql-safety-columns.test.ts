import { test } from "node:test";
import assert from "node:assert/strict";
import { SourceConfig } from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";

/**
 * The per-column half of the catalog (#12). `users.email` and `users.ssn` are
 * unexposed; everything else is. Each refusal is a different way of reading a
 * hidden column — by name, by `*`, by the whole row, by renaming it, or by
 * joining on it — and each acceptance is a nearby statement the rule must not
 * take down with it.
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
        { name: "user_id", type: "integer" },
      ],
    },
    {
      name: "users",
      timeField: "created_at",
      columns: [
        { name: "id", type: "integer" },
        { name: "created_at", type: "timestamp with time zone" },
        { name: "team", type: "text" },
        { name: "email", type: "text", exposed: false },
        { name: "ssn", type: "text", exposed: false },
        { name: "Mixed", type: "text", exposed: false },
      ],
    },
  ],
});

async function refused(sql: string, message?: RegExp): Promise<void> {
  const r = await validateSql(sql, source);
  assert.equal(r.ok, false, `expected refusal: ${sql}`);
  assert.equal(r.reason, "column", `${sql} -> ${r.error}`);
  if (message) assert.match(r.error ?? "", message, sql);
}

async function accepted(sql: string): Promise<void> {
  const r = await validateSql(sql, source);
  assert.equal(r.ok, true, `${sql} -> ${r.error}`);
}

test("an unexposed column is refused by name, with the table and column in the message", async () => {
  await refused("SELECT email FROM users", /^column not exposed: users\.email$/);
  await refused("SELECT u.ssn FROM users u", /^column not exposed: users\.ssn$/);
  await refused("SELECT metrics.users.email FROM metrics.users");
  await refused('SELECT "email" FROM users');
  await refused('SELECT "Mixed" FROM users');
});

test("an unexposed column is refused in every position, not only the select list", async () => {
  for (const sql of [
    "SELECT id FROM users WHERE email = 'a@example.com'",
    "SELECT id FROM users WHERE email LIKE 'a%'",
    "SELECT id FROM users ORDER BY ssn",
    "SELECT count(*) FROM users GROUP BY email",
    "SELECT team FROM users GROUP BY team HAVING max(ssn) > ''",
    "SELECT id, row_number() OVER (PARTITION BY email) FROM users",
    "SELECT DISTINCT ON (email) id FROM users",
    "SELECT CASE WHEN ssn IS NULL THEN 0 ELSE 1 END FROM users",
    "SELECT length(email)::int FROM users",
    "SELECT r.status FROM http_requests r JOIN users u ON u.email = 'x' AND u.id = r.user_id",
    "WITH x AS (SELECT email AS contact FROM users) SELECT contact FROM x",
    "SELECT contact FROM (SELECT email AS contact FROM users) s",
    "SELECT id FROM users WHERE EXISTS (SELECT 1 FROM users v WHERE v.ssn = '1')",
    "SELECT (SELECT max(email) FROM users) FROM http_requests",
    "SELECT r.status FROM http_requests r, LATERAL (SELECT u.email FROM users u WHERE u.id = r.user_id) l",
    "SELECT id FROM users UNION ALL SELECT ssn::int FROM users",
    "SELECT xmlforest(email) FROM users",
  ]) {
    await refused(sql);
  }
});

test("quoting is exact: a differently cased column is a different column", async () => {
  // Unquoted `Mixed` folds to `mixed`, which the catalog does not hide.
  await accepted("SELECT Mixed FROM users");
  // Unquoted `EMAIL` folds to `email`, which it does.
  await refused("SELECT EMAIL FROM users");
});

test("SELECT * is refused on a table with an unexposed column, and tells the author what to do", async () => {
  await refused(
    "SELECT * FROM users",
    /^SELECT \* is not allowed on users: it has unexposed columns; name the columns instead$/,
  );
  await refused("SELECT u.* FROM users u");
  await refused("SELECT users.* FROM users");
  await refused("SELECT * FROM metrics.users");
  await refused("TABLE users");
  await refused("SELECT * FROM users TABLESAMPLE system (10)");
  await refused("SELECT * FROM http_requests r JOIN users u ON u.id = r.user_id");
  await refused("SELECT status FROM http_requests UNION SELECT * FROM users");
  await refused("SELECT n FROM (SELECT * FROM users) s(n)");
  await refused("WITH x AS (SELECT * FROM users) SELECT id FROM x");
  await refused("SELECT count(u.*) FROM users u");
});

test("SELECT * over a subquery, a CTE, or a fully exposed table is still fine", async () => {
  await accepted("SELECT * FROM http_requests");
  await accepted("SELECT * FROM (SELECT id, team FROM users) s");
  await accepted("WITH x AS (SELECT id, team FROM users) SELECT * FROM x");
  await accepted(
    "WITH per AS (SELECT team, count(*) AS n FROM users GROUP BY team) SELECT per.* FROM per",
  );
  await accepted("SELECT r.* FROM http_requests r JOIN users u ON u.id = r.user_id");
  // A CTE named like the table shadows it; the body reads the real table by name.
  await accepted("WITH users AS (SELECT id, team FROM users) SELECT * FROM users");
});

test("a whole-row reference to a table with an unexposed column is refused", async () => {
  for (const sql of [
    "SELECT u FROM users u",
    "SELECT users FROM users",
    "SELECT metrics.users FROM metrics.users",
    "SELECT row_to_json(u) FROM users u",
    "SELECT to_jsonb(users) FROM users",
    "SELECT u::text FROM users u",
    "SELECT (u).email FROM users u",
    "SELECT (u).team FROM users u",
    "SELECT email(u) FROM users u",
    "SELECT (u.*).ssn FROM users u",
    "SELECT r.status FROM http_requests r, LATERAL row_to_json(u) j, users u",
    "SELECT count(DISTINCT u) FROM users u",
    "SELECT id FROM users u ORDER BY u",
  ]) {
    await refused(sql);
  }
  await refused("SELECT u FROM users u", /^whole-row reference to users is not allowed/);
});

test("a column alias list cannot rename a hidden column into view", async () => {
  await refused(
    "SELECT d FROM users AS u(a, b, c, d)",
    /^column aliases on users are not allowed/,
  );
  await refused("SELECT a FROM users u(a)");
  await refused(
    "SELECT j.x FROM (users u JOIN http_requests r ON r.user_id = u.id) AS j(x)",
  );
  // On a fully exposed table an alias list is harmless.
  await accepted("SELECT a FROM http_requests AS r(a)");
});

test("joins cannot match on a hidden column without naming it", async () => {
  await refused(
    "SELECT count(*) FROM users NATURAL JOIN (SELECT 'a@example.com' AS email) probe",
    /^NATURAL JOIN on users is not allowed/,
  );
  await refused(
    "SELECT count(*) FROM users JOIN (SELECT 'a@example.com' AS email) probe USING (email)",
    /^column not exposed: users\.email$/,
  );
  // A join alias over the table carries its row, but its exposed columns are fine.
  await refused("SELECT j FROM (users u JOIN http_requests r ON true) AS j");
  await refused("SELECT j.* FROM (users u JOIN http_requests r ON true) AS j");
  await refused("SELECT row_to_json(j) FROM users JOIN http_requests USING (ts) AS j");
  await accepted("SELECT j.team FROM (users u JOIN http_requests r ON true) AS j");
  await accepted("SELECT count(*) FROM users JOIN (SELECT 1 AS id) probe USING (id)");
  await accepted(
    "SELECT r.status, u.team FROM http_requests r JOIN users u ON u.id = r.user_id",
  );
});

test("exposed columns of the same table, and aggregates over its rows, stay usable", async () => {
  await accepted("SELECT id, team, created_at FROM users");
  await accepted("SELECT u.id, u.team FROM users u WHERE u.team = 'core' ORDER BY u.id");
  await accepted("SELECT count(*) FROM users");
  await accepted("SELECT team, count(*) AS n FROM users GROUP BY team ORDER BY n DESC");
  // An output alias may reuse an exposed name; the hidden column is never read.
  await accepted("SELECT team AS label FROM users ORDER BY label");
});

test("the rule is name-based across the statement, and errs toward refusing", async () => {
  // `http_requests` has no `email`, but the statement also reads `users`,
  // whose `email` is hidden. The guard does not resolve which table a name
  // belongs to; a statement that reads a restricted table may not use the name.
  await refused(
    "SELECT r.status AS email FROM http_requests r JOIN users u ON u.id = r.user_id ORDER BY email",
  );
  // A table that is not read imposes nothing: `email` here is only an alias.
  await accepted("SELECT status AS email FROM http_requests ORDER BY email");
});

test("a source with no unexposed column is unaffected", async () => {
  const open = SourceConfig.parse({
    ...source,
    tables: source.tables.map((t) => ({
      ...t,
      columns: t.columns.map(({ exposed: _, ...c }) => c),
    })),
  });
  for (const sql of [
    "SELECT * FROM users",
    "SELECT email, ssn FROM users",
    "SELECT row_to_json(u) FROM users u",
    "SELECT count(*) FROM users NATURAL JOIN http_requests",
    "SELECT d FROM users AS u(a, b, c, d)",
  ]) {
    const r = await validateSql(sql, open);
    assert.equal(r.ok, true, `${sql} -> ${r.error}`);
  }
});

test("an explicit exposed: true is the same as no flag at all", async () => {
  const explicit = SourceConfig.parse({
    ...source,
    tables: [
      {
        name: "users",
        columns: [
          { name: "id", type: "integer", exposed: true },
          { name: "email", type: "text", exposed: true },
        ],
      },
    ],
  });
  const r = await validateSql("SELECT * FROM users", explicit);
  assert.equal(r.ok, true, r.error);
});
