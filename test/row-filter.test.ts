import "./support/row-filter-env";
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { loadModule } from "libpg-query";
import { Client } from "pg";
import { HttpError } from "@/lib/auth/authorize";
import { attributesFromClaims, claimValue, parseGroups } from "@/lib/auth/claims";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";
import type { Dashboard } from "@/lib/ir";
import { getPoller, makePanelExecutor } from "@/lib/poller/registry";
import { buildQueryPlanView } from "@/lib/query-plan";
import {
  ModelSourceDraft,
  SourceConfig,
  SourceDraft,
  type SourceRecord,
} from "@/lib/registry";
import { assertRowFilterSavable, rowFilterFor, rowScopeFor } from "@/lib/row-scope";
import {
  applyRowFilter,
  bindRowFilter,
  ROW_FILTER_ALIAS,
  RowFilterDenied,
  RowFilterError,
} from "@/lib/sql/row-filter";
import { buildExecutablePlan, validateSql } from "@/lib/sql/safety";
import { asQueryPanel } from "./support/panels";

/**
 * Row-level filters (#31). The predicate narrows every table a statement
 * reads, where it reads it, so nothing the statement does afterwards — alias
 * the filter column, rename it, wrap itself in a CTE or a subquery, join, or
 * union — can see another tenant's rows. Proven twice: on the rewritten SQL,
 * and against a real PostgreSQL holding two tenants.
 */

before(async () => {
  // The rewrite runs synchronously inside buildExecutablePlan, after
  // validateSql has loaded the parser; these tests call it directly.
  await loadModule();
});

const config = SourceConfig.parse({
  host: "db",
  port: 5432,
  database: "metrics",
  schema: "metrics",
  rowFilter: { column: "tenant_id", claim: "tenant" },
  tables: [
    {
      name: "m",
      timeField: "ts",
      columns: [
        { name: "tenant_id", type: "text" },
        { name: "ts", type: "timestamptz" },
        { name: "v", type: "integer" },
      ],
    },
    {
      name: "n",
      columns: [
        { name: "tenant_id", type: "text" },
        { name: "k", type: "integer" },
      ],
    },
  ],
});

function source(cfg: SourceConfig = config): SourceRecord {
  return {
    id: "src-tenants",
    workspaceId: "ops",
    name: "tenants",
    kind: "timescaledb",
    config: cfg,
    secretRef: "TS_METRICS",
    createdBy: "admin",
    createdAt: "2026-10-04T00:00:00Z",
    tombstonedAt: null,
  } as unknown as SourceRecord;
}

const acme = {
  ...parseGroups("u-acme", ["/workspaces/ops/viewer"]),
  attributes: { tenant: "acme" },
};
const globex = {
  ...parseGroups("u-globex", ["/workspaces/ops/viewer"]),
  attributes: { tenant: "globex" },
};
const nobody = parseGroups("u-none", ["/workspaces/ops/viewer"]);

/* -------------------------------------------------------------------------- */
/* The rewrite                                                                */
/* -------------------------------------------------------------------------- */

const narrowed = (table: string, param = 3) =>
  `(SELECT * FROM ${table} AS ${ROW_FILTER_ALIAS} WHERE ${ROW_FILTER_ALIAS}.tenant_id = $${param})`;

test("every table is narrowed where it is read, and keeps the name it was known by", () => {
  assert.equal(
    applyRowFilter("SELECT sum(v) FROM m", "tenant_id", 3),
    `SELECT sum(v) FROM ${narrowed('"m"')} AS "m"`,
  );
  assert.equal(
    applyRowFilter(
      "SELECT h.v FROM metrics.m AS h JOIN n USING (tenant_id)",
      "tenant_id",
      1,
    ),
    `SELECT h.v FROM ${narrowed('"metrics"."m"', 1)} AS h JOIN ${narrowed('"n"', 1)} AS "n" USING (tenant_id)`,
  );
});

test("aliasing, renaming, CTEs and subqueries all read narrowed tables", () => {
  // [statement, how many real-table reads it has]. Every one must be narrowed
  // and no other `FROM <table>` may survive; `applyRowFilter` also checks the
  // rewritten tree itself, so this is the count from the outside.
  for (const [sql, tables] of [
    // The output says acme; the scan underneath is what decides.
    ["SELECT 'globex' AS tenant_id, sum(v) AS v FROM m", 1],
    ["SELECT tenant_id AS who, sum(v) FROM m GROUP BY 1", 1],
    ["WITH everything AS (SELECT * FROM m) SELECT sum(v) FROM everything", 1],
    // A CTE named like the table: its body's `metrics.m` is the real table,
    // and the outer `m` is the CTE.
    ["WITH m AS (SELECT * FROM metrics.m) SELECT sum(v) FROM m", 1],
    ["SELECT sum(v) FROM (SELECT * FROM m) x", 1],
    ["SELECT (SELECT sum(v) FROM m) AS v", 1],
    ["SELECT v FROM m UNION ALL SELECT k FROM n", 2],
    ["SELECT * FROM m a JOIN m b USING (ts)", 2],
    ["TABLE m", 1],
  ] as const) {
    const out = applyRowFilter(sql, "tenant_id", 3);
    const reads = out.split(" AS _holo_rf WHERE _holo_rf.tenant_id = $3)").length - 1;
    assert.equal(reads, tables, `${sql}\n→ ${out}`);
    // The CTE that shadows `m` is read as `FROM m` legitimately.
    if (sql.startsWith("WITH m AS")) continue;
    const bare = out.replace(/\(SELECT \* FROM [^()]* AS _holo_rf WHERE [^()]*\)/g, "");
    assert.doesNotMatch(
      bare,
      /\bFROM\s+("?metrics"?\.)?"?[mn]"?\s*(,|\)|$|\bWHERE|\bJOIN|\bUNION|AS (?!_holo_rf))/,
      out,
    );
  }
});

test("a CTE name is not a table, so it is left alone", () => {
  assert.equal(
    applyRowFilter("WITH x AS (SELECT * FROM m) SELECT * FROM x", "tenant_id", 3),
    `WITH x AS (SELECT * FROM ${narrowed('"m"')} AS "m") SELECT * FROM x`,
  );
});

test("the shapes the fuzzer found: TABLE, UESCAPE and the inheritance star", () => {
  assert.equal(
    applyRowFilter('table "metrics"."m"', "tenant_id", 3),
    `SELECT * FROM ${narrowed('"metrics"."m"')} AS "m"`,
  );
  assert.equal(
    applyRowFilter(`SELECT v FROM U&"!006d" UESCAPE '!' AS h`, "tenant_id", 3),
    `SELECT v FROM ${narrowed('"m"')} AS h`,
  );
  assert.equal(
    applyRowFilter("SELECT v FROM m * WHERE v > 1", "tenant_id", 3),
    `SELECT v FROM ${narrowed('"m"')} AS "m" WHERE v > 1`,
  );
});

test("bytes before a table are counted as the parser counts them", () => {
  assert.equal(
    applyRowFilter("SELECT 'é—ü' AS e, v FROM m", "tenant_id", 3),
    `SELECT 'é—ü' AS e, v FROM ${narrowed('"m"')} AS "m"`,
  );
});

test("what cannot be narrowed is refused, never run", () => {
  for (const [sql, why] of [
    ["SELECT * FROM ONLY m", /ONLY is not allowed/],
    ["SELECT * FROM m TABLESAMPLE SYSTEM (10)", /TABLESAMPLE is not allowed/],
    ["SELECT * FROM m AS _holo_rf", /reserved/],
  ] as const) {
    assert.throws(() => applyRowFilter(sql, "tenant_id", 3), RowFilterError, sql);
    assert.throws(() => applyRowFilter(sql, "tenant_id", 3), why, sql);
  }
  assert.throws(
    () => applyRowFilter("SELECT 1", "tenant_id; --", 3),
    /invalid row filter column/,
  );
});

test("the plan binds the value as the parameter after the time bounds, never inlined", async () => {
  const sql = "SELECT ts, v FROM m";
  assert.ok((await validateSql(sql, config)).ok);
  const from = new Date(0);
  const to = new Date(1);
  const hostile = "acme' OR '1'='1";
  const timed = buildExecutablePlan({
    sql,
    timeField: "ts",
    from,
    to,
    rowFilter: { column: "tenant_id", value: hostile },
  });
  assert.deepEqual(timed.params, [from, to, hostile]);
  assert.match(timed.sql, /_holo_rf\.tenant_id = \$3/);
  assert.ok(!timed.sql.includes(hostile));

  const untimed = buildExecutablePlan({
    sql,
    from,
    to,
    rowFilter: { column: "tenant_id", value: "acme" },
  });
  assert.deepEqual(untimed.params, ["acme"]);
  assert.match(untimed.sql, /_holo_rf\.tenant_id = \$1/);
});

test("a source with no row filter plans exactly as before", () => {
  const plan = buildExecutablePlan({
    sql: "SELECT ts, v FROM m",
    timeField: "ts",
    from: new Date(0),
    to: new Date(1),
    rowFilter: null,
  });
  assert.equal(
    plan.sql,
    `SELECT * FROM (SELECT ts, v FROM m) AS _holo
WHERE _holo.ts >= $1::timestamptz
  AND _holo.ts < $2::timestamptz
LIMIT ${plan.sql.match(/LIMIT (\d+)$/)?.[1]}`,
  );
  assert.equal(
    bindRowFilter({ rowFilter: undefined }, () => undefined),
    null,
  );
});

/* -------------------------------------------------------------------------- */
/* Whose value                                                                */
/* -------------------------------------------------------------------------- */

test("the value is the viewer's claim, and a viewer without it is refused", () => {
  assert.deepEqual(rowFilterFor(source(), acme), { column: "tenant_id", value: "acme" });
  assert.throws(
    () => rowFilterFor(source(), nobody),
    (err: unknown) => err instanceof HttpError && err.status === 403,
  );
  assert.throws(() => bindRowFilter(config, () => ""), RowFilterDenied);

  // `sub` is always available, for rows that belong to one person.
  const bySub = SourceConfig.parse({
    ...config,
    rowFilter: { column: "tenant_id", claim: "sub" },
  });
  assert.deepEqual(
    bindRowFilter(bySub, (c) => claimValue(nobody, c)),
    {
      column: "tenant_id",
      value: "u-none",
    },
  );
});

test("only single string or number claims become attributes", () => {
  assert.deepEqual(
    attributesFromClaims(
      {
        tenant: "acme",
        org: 42,
        list: ["a", "b"],
        obj: { a: 1 },
        empty: "",
        ctl: "a\nb",
      },
      ["tenant", "org", "list", "obj", "empty", "ctl", "absent"],
    ),
    { tenant: "acme", org: "42" },
  );
});

test("a session carries the configured claim from the realm token to the next request", async () => {
  const token = await signSessionToken("u-acme", ["/workspaces/ops/viewer"], {
    attributes: { tenant: "acme" },
  });
  const identity = await verifySessionToken(token);
  assert.deepEqual(identity?.attributes, { tenant: "acme" });
  assert.equal(identity && claimValue(identity, "tenant"), "acme");
  // An unconfigured claim in the token is not read.
  const other = await signSessionToken("u-x", [], { attributes: { region: "eu" } });
  assert.equal((await verifySessionToken(other))?.attributes, undefined);
});

/* -------------------------------------------------------------------------- */
/* Pollers                                                                    */
/* -------------------------------------------------------------------------- */

const dashboard: Dashboard = {
  specVersion: 1,
  title: "tenants",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 60_000,
  panels: [
    {
      id: "p1",
      title: "v",
      viz: "stat",
      query: { sourceId: "src-tenants", sql: "SELECT sum(v) AS value FROM m" },
      layout: { x: 0, y: 0, w: 6, h: 4 },
    },
  ],
} as Dashboard;

test("viewers share a poller only when they would see the same rows", () => {
  const noop = async () => [];
  const scope = (who: typeof acme) => rowScopeFor(who, [source()]);
  assert.deepEqual(scope(acme), { tenant: "acme" });
  assert.deepEqual(rowScopeFor(nobody, [source()]), {});

  const a1 = getPoller("dash-rf", 1, "ops", dashboard, scope(acme), noop);
  const a2 = getPoller(
    "dash-rf",
    1,
    "ops",
    dashboard,
    scope({ ...acme, sub: "u-acme-2" }),
    noop,
  );
  const g = getPoller("dash-rf", 1, "ops", dashboard, scope(globex), noop);
  assert.equal(a1, a2, "same tenant, same poller");
  assert.notEqual(a1, g, "another tenant never shares it");
  for (const p of [a1, g]) p.stop();
});

test("a panel whose source needs a claim the poller's scope lacks is refused, not run", async () => {
  const executor = makePanelExecutor(async () => source());
  const events = await executor(
    asQueryPanel(dashboard.panels[0]),
    { from: new Date(0), to: new Date(1) },
    "ops",
    {},
    {},
  );
  assert.deepEqual(events, [
    {
      type: "panel-error",
      panelId: "p1",
      error: "You have no access to this source's rows.",
      kind: "authorization",
    },
  ]);
});

/* -------------------------------------------------------------------------- */
/* Saving a source                                                            */
/* -------------------------------------------------------------------------- */

test("a row filter is saved only when a session can carry its claim and every table has its column", () => {
  assert.doesNotThrow(() => assertRowFilterSavable(config));
  const unconfigured = SourceConfig.parse({
    ...config,
    rowFilter: { column: "tenant_id", claim: "region" },
  });
  assert.throws(() => assertRowFilterSavable(unconfigured), /ROW_FILTER_CLAIMS/);
  const missingColumn = SourceConfig.parse({
    ...config,
    tables: [...config.tables, { name: "o", columns: [{ name: "k", type: "integer" }] }],
  });
  assert.throws(() => assertRowFilterSavable(missingColumn), /not in o/);
  // The column is a bare identifier, as a timeField is.
  assert.equal(
    SourceConfig.safeParse({
      ...config,
      rowFilter: { column: "t; drop", claim: "tenant" },
    }).success,
    false,
  );
});

test("the model cannot draft a row filter", () => {
  const draft = { id: "d", name: "d", secretRef: "TS_METRICS", config };
  assert.equal(SourceDraft.safeParse(draft).success, true);
  assert.equal(ModelSourceDraft.safeParse(draft).success, false);
  const { rowFilter: _, ...plain } = config;
  assert.equal(ModelSourceDraft.safeParse({ ...draft, config: plain }).success, true);
});

test("the plan view says where the filter's value came from", () => {
  const view = (timeField?: string) =>
    buildQueryPlanView({
      sql: "SELECT v FROM m",
      timeField,
      timeRange: { from: "now-1h", to: "now" },
      plan: buildExecutablePlan({
        sql: "SELECT v FROM m",
        timeField,
        from: new Date(0),
        to: new Date(1),
        rowFilter: { column: "tenant_id", value: "acme" },
      }),
      session: [],
      limits: { maxRows: 1, statementTimeoutMs: 1, maxResultBytes: 1 },
      rowFilterClaim: "tenant",
    }).params.map((p) => [p.placeholder, p.from]);
  assert.deepEqual(view("ts"), [
    ["$1", "now-1h"],
    ["$2", "now"],
    ["$3", 'your "tenant" claim'],
  ]);
  assert.deepEqual(view(undefined), [["$1", 'your "tenant" claim']]);
});

/* -------------------------------------------------------------------------- */
/* Against a real server: two tenants, every way round the filter             */
/* -------------------------------------------------------------------------- */

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("no statement reads another tenant's rows", {
  skip: dbUrl ? false : "run with npm run test:integration (needs Docker)",
}, async () => {
  const schema = `rf_test_${process.pid}`;
  const scoped = SourceConfig.parse({ ...config, schema });
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE m (tenant_id text, ts timestamptz, v integer);
      CREATE TABLE n (tenant_id text, k integer);
      INSERT INTO m VALUES
        ('acme', '2026-10-04T10:00:00Z', 1), ('acme', '2026-10-04T10:01:00Z', 2),
        ('acme', '2026-10-04T10:02:00Z', 3),
        ('globex', '2026-10-04T10:00:00Z', 100), ('globex', '2026-10-04T10:01:00Z', 200);
      INSERT INTO n VALUES ('acme', 10), ('globex', 1000);
    `);

    const run = async (sql: string, timeField?: string) => {
      const check = await validateSql(sql, scoped);
      assert.ok(check.ok, `${sql}: ${check.ok ? "" : check.error}`);
      const plan = buildExecutablePlan({
        sql,
        timeField,
        from: new Date("2026-10-04T00:00:00Z"),
        to: new Date("2026-10-05T00:00:00Z"),
        rowFilter: bindRowFilter(scoped, (c) => claimValue(acme, c)),
      });
      return (await client.query(plan.sql, plan.params)).rows;
    };
    const sum = async (sql: string) => Number((await run(sql))[0]?.v);

    // acme's rows: m = 1 + 2 + 3, n = 10. globex's would add 300 and 1000.
    assert.equal(await sum("SELECT 'globex' AS tenant_id, sum(v) AS v FROM m"), 6);
    assert.deepEqual(
      await run("SELECT tenant_id AS who, sum(v)::int AS v FROM m GROUP BY 1"),
      [{ who: "acme", v: 6 }],
    );
    assert.equal(
      await sum(
        "WITH everything AS (SELECT * FROM m) SELECT sum(v) AS v FROM everything",
      ),
      6,
    );
    assert.equal(
      await sum(`WITH m AS (SELECT * FROM ${schema}.m) SELECT sum(v) AS v FROM m`),
      6,
    );
    assert.equal(await sum("SELECT sum(v) AS v FROM (SELECT * FROM m) x"), 6);
    assert.equal(await sum("SELECT (SELECT sum(v) FROM m) AS v"), 6);
    assert.equal(
      await sum("SELECT sum(v) AS v FROM m WHERE tenant_id = 'globex' OR true"),
      6,
    );
    assert.equal(await sum(`SELECT sum(v) AS v FROM ${schema}.m`), 6);
    assert.equal(await sum("SELECT count(*) AS v FROM m JOIN n USING (tenant_id)"), 3);
    assert.equal(await sum("SELECT count(*) AS v FROM m CROSS JOIN n"), 3);
    assert.equal(
      await sum(
        "SELECT sum(x) AS v FROM (SELECT v AS x FROM m UNION ALL SELECT k FROM n) u",
      ),
      16,
    );
    assert.equal(await sum("SELECT DISTINCT sum(v) OVER () AS v FROM m"), 6);
    assert.deepEqual(
      (await run("TABLE m")).map((r) => r.tenant_id),
      ["acme", "acme", "acme"],
    );
    // And through the server's own time wrapper.
    assert.deepEqual(
      (await run("SELECT ts, v FROM m ORDER BY ts", "ts")).map((r) => r.v),
      [1, 2, 3],
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
