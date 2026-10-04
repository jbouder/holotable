import { test } from "node:test";
import assert from "node:assert/strict";
import { ColumnImpact, describeHideImpact } from "@/lib/catalog/browse";
import { hiddenColumnImpact, type PanelStatement } from "@/lib/catalog/hide-impact";
import { renderMetrics, resetMetricsForTests } from "@/lib/metrics";
import { SourceConfig } from "@/lib/registry";
import { checkSql, validateSql } from "@/lib/sql/safety";

/**
 * Warning before hiding a column (#267): which current panels the guard would
 * start refusing, decided by the guard itself, uncounted, and reported
 * without their SQL.
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
        { name: "status", type: "smallint" },
        { name: "route", type: "text" },
      ],
    },
  ],
});

function panel(dashboard: string, id: string, sql: string): PanelStatement {
  return {
    dashboardId: dashboard,
    dashboardTitle: `Dashboard ${dashboard}`,
    panelId: id,
    panelTitle: `Panel ${id}`,
    sql,
  };
}

const PANELS: PanelStatement[] = [
  panel("a", "by-name", "SELECT ts, status FROM http_requests"),
  panel(
    "a",
    "filter",
    "SELECT ts, count(*) FROM http_requests WHERE status >= 500 GROUP BY ts",
  ),
  panel("a", "unrelated", "SELECT ts, route FROM http_requests"),
  panel("b", "star", "SELECT * FROM http_requests"),
  panel("b", "whole-row", "SELECT row_to_json(r) FROM http_requests r"),
  // Already refused for other reasons: not this change's doing.
  panel("b", "bad-table", "SELECT status FROM pg_catalog.pg_authid"),
  panel("b", "clock", "SELECT now(), status FROM http_requests"),
  panel("c", "only-unrelated", "SELECT route FROM http_requests"),
];

test("the panels the guard would start refusing, grouped by dashboard, in order", async () => {
  const dashboards = await hiddenColumnImpact(config, PANELS, "http_requests", "status");
  assert.deepEqual(dashboards, [
    {
      id: "a",
      title: "Dashboard a",
      panels: [
        { id: "by-name", title: "Panel by-name" },
        { id: "filter", title: "Panel filter" },
      ],
    },
    {
      id: "b",
      title: "Dashboard b",
      panels: [
        { id: "star", title: "Panel star" },
        { id: "whole-row", title: "Panel whole-row" },
      ],
    },
  ]);
});

test("the verdict agrees with validateSql after the change, panel by panel", async () => {
  const dashboards = await hiddenColumnImpact(config, PANELS, "http_requests", "route");
  const flagged = new Set(dashboards?.flatMap((d) => d.panels.map((p) => p.id)));
  const hidden = SourceConfig.parse({
    ...config,
    tables: [
      {
        ...config.tables[0],
        columns: config.tables[0].columns.map((c) =>
          c.name === "route" ? { ...c, exposed: false } : c,
        ),
      },
    ],
  });
  for (const p of PANELS) {
    const before = (await validateSql(p.sql, config)).ok;
    const after = (await validateSql(p.sql, hidden)).ok;
    assert.equal(flagged.has(p.panelId), before && !after, p.sql);
  }
});

test("a column nothing reads breaks nothing, and an unknown column is null", async () => {
  const none = await hiddenColumnImpact(
    config,
    [panel("a", "x", "SELECT ts FROM http_requests")],
    "http_requests",
    "route",
  );
  assert.deepEqual(none, []);
  assert.equal(
    describeHideImpact({ table: "http_requests", column: "route", dashboards: [] }),
    null,
  );
  assert.equal(await hiddenColumnImpact(config, PANELS, "http_requests", "email"), null);
  assert.equal(await hiddenColumnImpact(config, PANELS, "users", "status"), null);
});

test("the dry run records no SQL rejection, while validateSql still does", async () => {
  resetMetricsForTests();
  await hiddenColumnImpact(config, PANELS, "http_requests", "status");
  assert.equal((await checkSql("SELECT now() FROM http_requests", config)).ok, false);
  assert.doesNotMatch(
    await renderMetrics(),
    /holotable_sql_validation_rejections_total\{/,
  );

  await validateSql("SELECT now() FROM http_requests", config);
  assert.match(
    await renderMetrics(),
    /holotable_sql_validation_rejections_total\{reason="time"\} 1/,
  );
});

test("the impact carries ids and titles, never SQL, and matches the client contract", async () => {
  const dashboards = await hiddenColumnImpact(config, PANELS, "http_requests", "status");
  const impact = { table: "http_requests", column: "status", dashboards };
  assert.equal(ColumnImpact.safeParse(impact).success, true);
  const serialized = JSON.stringify(impact);
  for (const fragment of ["SELECT", "FROM", "row_to_json"]) {
    assert.equal(serialized.includes(fragment), false, `the impact leaked ${fragment}`);
  }
  assert.equal(
    describeHideImpact(ColumnImpact.parse(impact)),
    "Hiding http_requests.status will break 4 panels across 2 dashboards: their SQL reads it, and the guard will refuse it until they are changed.",
  );
});
