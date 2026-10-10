import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type Dashboard,
  declaredVariables,
  hasQuery,
  isDatumLink,
  isSelfLink,
  parseDashboard,
} from "@/lib/ir";
import type { CatalogTable, SqlSourceConfig } from "@/lib/registry";
import { validateSql } from "@/lib/sql/safety";
import { compileVegaLite } from "@/lib/vega/compile";
import {
  type DemoLinkTargets,
  demoSpec,
  customVisualsSpec,
  fleetGridSpec,
  logsSpec,
  fleetSpec,
  hostDetailSpec,
  systemSpec,
} from "../scripts/lib/demo-dashboards";
import { queryOf } from "./support/panels";

/**
 * The demo dashboards the seeder writes, held to the IR and the SQL guard
 * against the seeded catalogs (copied from `scripts/seed.ts`, which connects to
 * a database when it is loaded), and their drilldown links to the dashboard
 * they open.
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

const APP_LOGS: CatalogTable = {
  name: "app_logs",
  description: "gateway log lines, one per event",
  timeField: "ts",
  columns: [
    { name: "ts", type: "timestamp with time zone" },
    { name: "host", type: "text" },
    { name: "level", type: "text", description: "error, warn, info or debug" },
    { name: "route", type: "text" },
    { name: "message", type: "text" },
    { name: "request_id", type: "text" },
  ],
};

function source(table: CatalogTable): SqlSourceConfig {
  return {
    kind: "timescaledb",
    host: "localhost",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables: [table],
  };
}

const SOURCES: Record<string, SqlSourceConfig> = {
  "ts-metrics": source(HTTP_REQUESTS),
  "ts-system": source(SYSTEM_METRICS),
  "ts-logs": source(APP_LOGS),
};

const TARGETS: DemoLinkTargets = { hostDetail: "00000000-0000-4000-8000-000000000001" };

const SPECS: Record<string, Dashboard> = {
  demo: parseDashboard(demoSpec()),
  system: parseDashboard(systemSpec(TARGETS)),
  fleet: parseDashboard(fleetSpec(TARGETS)),
  fleetGrid: parseDashboard(fleetGridSpec(TARGETS)),
  logs: parseDashboard(logsSpec()),
  customVisuals: parseDashboard(customVisualsSpec()),
  hostDetail: parseDashboard(hostDetailSpec()),
};

for (const [name, spec] of Object.entries(SPECS)) {
  test(`the ${name} demo dashboard's SQL passes the guard`, async () => {
    const declared = declaredVariables(spec);
    for (const variable of spec.variables ?? []) {
      if (!variable.query || !("sql" in variable.query)) continue;
      const cfg = SOURCES[variable.query.sourceId];
      assert.ok(cfg, `variable "${variable.name}" names an unseeded source`);
      const check = await validateSql(variable.query.sql, cfg, declared);
      assert.ok(check.ok, `variable "${variable.name}": ${check.reason}`);
    }
    for (const panel of spec.panels.filter(hasQuery)) {
      const query = queryOf(panel);
      const cfg = SOURCES[query.sourceId];
      assert.ok(cfg, `panel "${panel.id}" names an unseeded source`);
      const check = await validateSql(query.sql, cfg, declared);
      assert.ok(check.ok, `panel "${panel.id}": ${check.reason}`);
    }
  });
}

test("the demo links lead to the host detail dashboard and set only its host", () => {
  const hostVariables = declaredVariables(SPECS.hostDetail);
  const links = [SPECS.system, SPECS.fleet, SPECS.fleetGrid].flatMap((spec) =>
    spec.panels.flatMap((panel) => panel.links ?? []),
  );
  assert.ok(links.length >= 3, "the fleet and infrastructure dashboards link out");
  for (const link of links) {
    assert.equal(link.dashboard, TARGETS.hostDetail);
    for (const name of Object.keys(link.set ?? {})) {
      assert.ok(hostVariables.has(name), `link "${link.title}" sets "${name}"`);
    }
  }
  // Both flavors are on show: a click on a datum, and an item in the menu.
  assert.ok(links.some(isDatumLink));
  assert.ok(links.some((link) => !isDatumLink(link)));
});

test("the host detail dashboard filters itself from its host table", () => {
  const hosts = SPECS.hostDetail.panels.find((panel) => panel.id === "hosts");
  const self = hosts?.links?.find(isSelfLink);
  assert.deepEqual(self?.set, { host: { column: "host" } });
});

test("every custom visual on a demo dashboard compiles (#405)", async () => {
  const visuals = Object.values(SPECS).flatMap((spec) =>
    spec.panels.filter((panel) => panel.viz === "vega"),
  );
  assert.ok(visuals.length >= 3, "the demo shows custom visuals");
  for (const panel of visuals) {
    const result = await compileVegaLite((panel.options as { spec: unknown }).spec);
    assert.ok(result.ok, `${panel.id}: ${result.ok ? "" : result.error}`);
  }
});
