import { test } from "node:test";
import assert from "node:assert/strict";
import type { CatalogSubject } from "@/lib/catalog/health";
import { buildBuiltinTemplates } from "@/lib/builtin-templates";
import type { CatalogTable, SourceConfig } from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";
import { templatePanels } from "@/lib/templates";

/**
 * The seeded demo catalogs, copied from `scripts/seed.ts`.
 *
 * Copied rather than imported because the seeder opens a database connection
 * at module scope. The acceptance criterion is that the shipped starters work
 * against these sources, so the shapes are pinned here and the SQL is put
 * through the real guard below — a template that names a column the demo does
 * not have fails this file rather than a first-run user's first dashboard.
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
    { name: "region", type: "text" },
    { name: "cpu_pct", type: "double precision" },
    { name: "mem_pct", type: "double precision" },
    { name: "disk_pct", type: "double precision" },
    { name: "net_in_bytes", type: "bigint" },
    { name: "net_out_bytes", type: "bigint" },
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

function source(tables: CatalogTable[], id = "ts-metrics"): CatalogSubject {
  return {
    id,
    name: "Demo",
    config: config(tables),
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
  };
}

/* -------------------------------------------------------------------------- */
/* The acceptance criterion: they work against the seeded demo sources        */
/* -------------------------------------------------------------------------- */

test("every built-in statement passes the real guard against its own source", async () => {
  for (const tables of [
    [HTTP_REQUESTS],
    [SYSTEM_METRICS],
    [HTTP_REQUESTS, SYSTEM_METRICS],
  ]) {
    const cfg = config(tables);
    const templates = buildBuiltinTemplates(source(tables));
    assert.ok(templates.length > 0, "the demo catalogs support starters");

    for (const template of templates) {
      for (const panel of templatePanels(template.body)) {
        const check = await validateSql(panel.query.sql, cfg);
        assert.ok(
          check.ok,
          `${template.name} / ${panel.title}: ${check.error}\n${panel.query.sql}`,
        );
      }
    }
  }
});

test("every built-in panel declares the time field the server injects on", () => {
  for (const template of buildBuiltinTemplates(source([HTTP_REQUESTS]))) {
    for (const panel of templatePanels(template.body)) {
      assert.equal(panel.query.timeField, "bucket");
      assert.match(panel.query.sql, /AS bucket\b/);
    }
  }
});

test("no built-in filters time itself — the server owns the range", () => {
  for (const template of buildBuiltinTemplates(source([HTTP_REQUESTS, SYSTEM_METRICS]))) {
    for (const panel of templatePanels(template.body)) {
      assert.doesNotMatch(panel.query.sql, /\bWHERE\b/i);
    }
  }
});

test("every built-in panel references only its own source", () => {
  for (const template of buildBuiltinTemplates(source([HTTP_REQUESTS], "ts-metrics"))) {
    for (const panel of templatePanels(template.body)) {
      assert.equal(panel.query.sourceId, "ts-metrics");
    }
  }
});

/* -------------------------------------------------------------------------- */
/* Which signals a catalog supports                                           */
/* -------------------------------------------------------------------------- */

function names(subject: CatalogSubject): string[] {
  return buildBuiltinTemplates(subject).map((t) => t.name);
}

test("the demo request table supports all four signals plus a dashboard", () => {
  const built = buildBuiltinTemplates(source([HTTP_REQUESTS]));
  assert.deepEqual(
    built.filter((t) => t.kind === "panel").map((t) => t.id),
    [
      "builtin:ts-metrics:http_requests:rate",
      "builtin:ts-metrics:http_requests:errors",
      "builtin:ts-metrics:http_requests:duration",
      "builtin:ts-metrics:http_requests:saturation",
    ],
  );
  assert.deepEqual(
    built.filter((t) => t.kind === "dashboard").map((t) => t.id),
    ["builtin:ts-metrics:http_requests:golden-signals"],
  );
});

test("a signal with no column to read is not offered", () => {
  // No category column, so no errors breakdown; no latency column, so no
  // duration. `cpu_pct` still reads as saturation.
  const built = names(source([SYSTEM_METRICS]));
  assert.ok(built.some((n) => n.startsWith("Rate")));
  assert.ok(built.some((n) => n.startsWith("Saturation")));
  assert.equal(
    built.some((n) => n.startsWith("Errors") || n.startsWith("Duration")),
    false,
  );
});

test("an HTTP status is a breakdown, never something to average", () => {
  const [duration] = buildBuiltinTemplates(source([HTTP_REQUESTS])).filter((t) =>
    t.id.endsWith(":duration"),
  );
  const sql = templatePanels(duration.body)[0].query.sql;
  assert.match(sql, /avg\(duration_ms\)/);
  assert.doesNotMatch(sql, /avg\(status\)/);
});

test("a table with no time column contributes nothing", () => {
  const timeless: CatalogTable = {
    name: "lookup",
    columns: [
      { name: "id", type: "bigint" },
      { name: "label", type: "text" },
    ],
  };
  assert.deepEqual(buildBuiltinTemplates(source([timeless])), []);
});

test("a kind filter returns only that kind", () => {
  const panels = buildBuiltinTemplates(source([HTTP_REQUESTS]), "panel");
  const dashboards = buildBuiltinTemplates(source([HTTP_REQUESTS]), "dashboard");
  assert.ok(panels.length > 0 && panels.every((t) => t.kind === "panel"));
  assert.ok(dashboards.length > 0 && dashboards.every((t) => t.kind === "dashboard"));
});

/* -------------------------------------------------------------------------- */
/* A catalog is not trusted text                                              */
/* -------------------------------------------------------------------------- */

test("a name that is not a plain identifier is skipped, never escaped", () => {
  const hostile: CatalogTable = {
    name: "requests; DROP TABLE users",
    timeField: "ts",
    columns: [
      { name: "ts", type: "timestamp with time zone" },
      { name: "duration_ms", type: "double precision" },
    ],
  };
  assert.deepEqual(buildBuiltinTemplates(source([hostile])), []);

  const hostileColumn: CatalogTable = {
    name: "requests",
    timeField: "ts",
    columns: [
      { name: "ts", type: "timestamp with time zone" },
      { name: "duration_ms) FROM x --", type: "double precision" },
    ],
  };
  const built = buildBuiltinTemplates(source([hostileColumn]));
  // The rate panel names no column, so it survives; the duration signal has
  // nothing it may name and is dropped rather than quoted into the statement.
  assert.deepEqual(
    built.map((t) => t.id),
    ["builtin:ts-metrics:requests:rate"],
  );
});

test("a table the last refresh could not find contributes nothing", () => {
  const subject: CatalogSubject = {
    ...source([HTTP_REQUESTS, SYSTEM_METRICS]),
    catalogMissingTables: ["http_requests"],
  };
  assert.equal(
    buildBuiltinTemplates(subject).every((t) => !t.id.includes("http_requests")),
    true,
  );
});

test("the same catalog always produces the same list", () => {
  assert.deepEqual(
    buildBuiltinTemplates(source([HTTP_REQUESTS, SYSTEM_METRICS])),
    buildBuiltinTemplates(source([HTTP_REQUESTS, SYSTEM_METRICS])),
  );
});
