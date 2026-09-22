import { test } from "node:test";
import assert from "node:assert/strict";
import { Panel } from "@/lib/ir";
import {
  isStarterSql,
  panelStarter,
  PLACEHOLDER_SQL,
  starterPanel,
} from "@/lib/panel-starter";
import type { CatalogTable, SourceConfig } from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";

/**
 * The seeded demo catalogs, copied from `scripts/seed.ts` for the same reason
 * `test/builtin-templates.test.ts` copies them: the seeder opens a database
 * connection at module scope. The acceptance criterion is that a new panel
 * starts from a query that works against these sources, so the shapes are
 * pinned here and the SQL goes through the real guard below.
 */
const HTTP_REQUESTS: CatalogTable = {
  name: "http_requests",
  description: "per-request events",
  timeField: "ts",
  columns: [
    { name: "ts", type: "timestamp with time zone" },
    { name: "service", type: "text" },
    { name: "route", type: "text" },
    { name: "status", type: "smallint" },
    { name: "duration_ms", type: "double precision" },
    { name: "bytes", type: "bigint" },
  ],
};

const SYSTEM_METRICS: CatalogTable = {
  name: "system_metrics",
  description: "per-host infrastructure metrics",
  timeField: "ts",
  columns: [
    { name: "ts", type: "timestamp with time zone" },
    { name: "host", type: "text" },
    { name: "cpu_pct", type: "double precision" },
  ],
};

/** A table with no timestamp column anywhere — the non-time fallback. */
const TENANTS: CatalogTable = {
  name: "tenants",
  columns: [
    { name: "id", type: "uuid" },
    { name: "name", type: "text" },
  ],
};

function config(tables: CatalogTable[]): SourceConfig {
  return {
    host: "timescaledb",
    port: 5432,
    database: "holotable",
    schema: "public",
    ssl: false,
    tables,
  };
}

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };

/* -------------------------------------------------------------------------- */
/* The acceptance criterion: the starter executes against the demo sources     */
/* -------------------------------------------------------------------------- */

test("the starter passes the real guard against every demo catalog", async () => {
  for (const tables of [
    [HTTP_REQUESTS],
    [SYSTEM_METRICS],
    [HTTP_REQUESTS, SYSTEM_METRICS],
    [TENANTS],
    [TENANTS, HTTP_REQUESTS],
  ]) {
    const starter = panelStarter({ tables });
    const check = await validateSql(starter.sql, config(tables));
    assert.ok(check.ok, `${starter.title}: ${check.error}\n${starter.sql}`);
  }
});

test("the placeholder is still a panel when the catalog offers nothing", async () => {
  const starter = panelStarter({ tables: [] });
  assert.equal(starter.sql, PLACEHOLDER_SQL);
  assert.equal(starter.timeField, undefined);
  const check = await validateSql(starter.sql, config([HTTP_REQUESTS]));
  assert.ok(check.ok, check.ok ? "" : check.error);
});

test("a null catalog falls back rather than throwing", () => {
  assert.equal(panelStarter(null).sql, PLACEHOLDER_SQL);
});

/* -------------------------------------------------------------------------- */
/* What it picks                                                              */
/* -------------------------------------------------------------------------- */

test("a table with a time column gets a time series declaring its bucket", () => {
  const starter = panelStarter({ tables: [HTTP_REQUESTS] });
  assert.equal(starter.viz, "line");
  assert.equal(starter.timeField, "bucket");
  assert.match(starter.sql, /date_trunc\('minute', ts\) AS bucket/);
  assert.match(starter.sql, /FROM http_requests/);
  assert.equal(starter.title, "http_requests per minute");
});

test("the starter never filters time itself — the server owns the range", () => {
  for (const tables of [[HTTP_REQUESTS], [SYSTEM_METRICS], [TENANTS]]) {
    assert.doesNotMatch(panelStarter({ tables }).sql, /\bWHERE\b/i);
  }
});

test("a source with no time column gets a stat, not an empty chart", () => {
  const starter = panelStarter({ tables: [TENANTS] });
  assert.equal(starter.viz, "stat");
  assert.equal(starter.timeField, undefined);
  assert.equal(starter.sql, "SELECT count(*) AS value\nFROM tenants");
});

test("a time-series table is preferred over an earlier one without a time column", () => {
  const starter = panelStarter({ tables: [TENANTS, SYSTEM_METRICS] });
  assert.match(starter.sql, /FROM system_metrics/);
});

test("a table whose name is not a plain identifier is skipped, not escaped", () => {
  const hostile: CatalogTable = {
    name: 'ev"il; DROP TABLE x --',
    timeField: "ts",
    columns: [{ name: "ts", type: "timestamp with time zone" }],
  };
  const starter = panelStarter({ tables: [hostile, HTTP_REQUESTS] });
  assert.match(starter.sql, /FROM http_requests/);
  assert.doesNotMatch(starter.sql, /DROP TABLE/);
});

test("a hostile column name is skipped the same way", () => {
  const hostile: CatalogTable = {
    name: "events",
    timeField: 'ts"; DROP TABLE x --',
    columns: [
      { name: 'ts"; DROP TABLE x --', type: "timestamp with time zone" },
      { name: "value", type: "double precision" },
    ],
  };
  const starter = panelStarter({ tables: [hostile] });
  assert.equal(starter.viz, "stat");
  assert.doesNotMatch(starter.sql, /DROP TABLE/);
});

test("the built panel satisfies the IR", () => {
  const panel = starterPanel("panel-1", "src-1", { tables: [HTTP_REQUESTS] }, LAYOUT);
  const parsed = Panel.safeParse(panel);
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  assert.equal(panel.query.sourceId, "src-1");
});

/* -------------------------------------------------------------------------- */
/* What counts as untouched, for the delete confirmation                      */
/* -------------------------------------------------------------------------- */

test("a freshly added panel is recognised as still being its starter", () => {
  const catalog = { tables: [HTTP_REQUESTS] };
  const panel = starterPanel("panel-1", "src-1", catalog, LAYOUT);
  assert.equal(isStarterSql(panel.query.sql, catalog), true);
});

test("the old placeholder still counts as untouched", () => {
  assert.equal(isStarterSql(PLACEHOLDER_SQL, { tables: [HTTP_REQUESTS] }), true);
  assert.equal(isStarterSql("  select 1 as value  ", null), false);
});

test("an edited query is work worth confirming before deleting", () => {
  const catalog = { tables: [HTTP_REQUESTS] };
  assert.equal(
    isStarterSql(
      "SELECT count(*) AS value FROM http_requests WHERE status >= 500",
      catalog,
    ),
    false,
  );
});

test("reflowed whitespace is still the starter", () => {
  const catalog = { tables: [HTTP_REQUESTS] };
  const reflowed = panelStarter(catalog).sql.replace(/\n/g, " ");
  assert.equal(isStarterSql(reflowed, catalog), true);
});
