import { test } from "node:test";
import assert from "node:assert/strict";
import { Panel } from "@/lib/ir";
import {
  isStarterQuery,
  isStarterSql,
  PLACEHOLDER_PROMQL,
  panelStarter,
  PLACEHOLDER_SQL,
  promqlStarter,
  starterPanel,
  starterQuery,
} from "@/lib/panel-starter";
import { validatePromql } from "@/lib/promql/safety";
import type { PrometheusCatalog } from "@/lib/sources/kinds/prometheus";
import type { CatalogTable, SqlSourceConfig } from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";
import { queryOf } from "./support/panels";

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

function config(tables: CatalogTable[]): SqlSourceConfig {
  return {
    kind: "timescaledb",
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
  assert.equal(panel.query?.sourceId, "src-1");
});

/* -------------------------------------------------------------------------- */
/* What counts as untouched, for the delete confirmation                      */
/* -------------------------------------------------------------------------- */

test("a freshly added panel is recognised as still being its starter", () => {
  const catalog = { tables: [HTTP_REQUESTS] };
  const panel = starterPanel("panel-1", "src-1", catalog, LAYOUT);
  assert.equal(isStarterSql(queryOf(panel).sql, catalog), true);
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

/* -------------------------------------------------------------------------- */
/* PromQL (#388)                                                              */
/* -------------------------------------------------------------------------- */

const PROM: PrometheusCatalog = {
  metrics: [
    { name: "up", type: "gauge", labels: ["instance", "job"] },
    { name: "http_requests_total", type: "counter", labels: ["code", "job"] },
    { name: "req_seconds_bucket", type: "histogram", labels: ["le"] },
  ],
};

function promConfig(catalog: PrometheusCatalog) {
  return { metrics: catalog.metrics.map((m) => ({ ...m })) };
}

test("a PromQL starter is a counter's rate, as a range for a line and an instant for a stat", () => {
  assert.deepEqual(promqlStarter(PROM), {
    promql: "sum(rate(http_requests_total[5m]))",
    viz: "line",
    title: "http_requests_total per second",
  });
  assert.equal(promqlStarter(PROM, "stat").instant, true);
  assert.equal(promqlStarter(PROM, "table").instant, true);
  assert.equal("instant" in promqlStarter(PROM, "bar"), false);
});

test("without a counter, a histogram's p95, then a gauge, then a count, then a constant", () => {
  const noCounter = { metrics: PROM.metrics.filter((m) => m.type !== "counter") };
  assert.match(promqlStarter(noCounter).promql, /^histogram_quantile\(0\.95/);
  const gaugeOnly = { metrics: [PROM.metrics[0]] };
  assert.equal(promqlStarter(gaugeOnly).promql, "sum(up)");
  const unknown = { metrics: [{ name: "x", type: "unknown" as const, labels: [] }] };
  assert.equal(promqlStarter(unknown).promql, "count(x)");
  assert.equal(promqlStarter({ metrics: [] }).promql, PLACEHOLDER_PROMQL);
});

test("every PromQL starter passes the real guard against its catalog", () => {
  for (const catalog of [PROM, { metrics: [PROM.metrics[0]] }, { metrics: [] }]) {
    for (const viz of ["line", "stat", "table"] as const) {
      const starter = promqlStarter(catalog, viz);
      const check = validatePromql(starter.promql, promConfig(catalog));
      assert.ok(check.ok, `${starter.promql}: ${check.ok ? "" : check.error}`);
    }
  }
});

test("a metric name the guard would not read bare is skipped", () => {
  const hostile = {
    metrics: [
      { name: 'x"}or vector(1)', type: "counter" as const, labels: [] },
      ...PROM.metrics,
    ],
  };
  assert.doesNotMatch(promqlStarter(hostile).promql, /vector/);
});

test("starterQuery writes in the catalog's language, and a new panel on a Prometheus source is PromQL", () => {
  assert.deepEqual(starterQuery("prom", PROM, "gauge").query, {
    sourceId: "prom",
    promql: "sum(rate(http_requests_total[5m]))",
    instant: true,
  });
  const sql = starterQuery("ts", { tables: [HTTP_REQUESTS] }).query;
  assert.ok("sql" in sql);
  const panel = starterPanel("p", "prom", PROM, LAYOUT);
  assert.ok(Panel.safeParse(panel).success);
  assert.ok(panel.query && "promql" in panel.query);
});

test("a PromQL starter counts as untouched for the delete confirmation; an edit does not", () => {
  const panel = starterPanel("p", "prom", PROM, LAYOUT);
  assert.ok(panel.query);
  assert.equal(isStarterQuery(panel.query, PROM), true);
  assert.equal(
    isStarterQuery({ sourceId: "prom", promql: PLACEHOLDER_PROMQL }, PROM),
    true,
  );
  assert.equal(isStarterQuery({ sourceId: "prom", promql: "sum(up)" }, PROM), false);
  assert.equal(
    isStarterQuery({ sourceId: "ts", sql: PLACEHOLDER_SQL }, { tables: [HTTP_REQUESTS] }),
    true,
  );
});
