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
import { PANEL_KIND_NAMES } from "@/lib/panels/registry";
import { selfMonitoringSpec } from "@/lib/self-monitoring/dashboard";
import {
  type DemoLinkTargets,
  demoSpec,
  fleetSpec,
  hostDetailSpec,
  RETIRED_DEMO_DASHBOARDS,
} from "../scripts/lib/demo-dashboards";
import {
  DEMO_FILES_SOURCE_ID,
  DEMO_HOSTS,
  DEMO_LINKS,
  demoFilesConfig,
  demoFilesSpec,
} from "../scripts/lib/demo-files";
import { HOSTS } from "../scripts/lib/seed-data";
import {
  ALLOCATION_TABLES,
  ALLOCATION_WEEKS_AHEAD,
  ALLOCATION_WEEKS_BACK,
  ALLOCATIONS_SOURCE_ID,
  allocationRows,
  allocationsSpec,
  PEOPLE,
  PROJECTS,
  weekStart,
} from "../scripts/lib/demo-allocations";
import {
  graphClickDatum,
  graphDatum,
  graphEdgeId,
  graphView,
} from "@/components/charts/graph";
import { sankeyClickDatum, sankeyNet } from "@/components/charts/sankey";
import { datumLinkItems } from "@/lib/drilldown";
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

const SERVICE_CALLS: CatalogTable = {
  name: "service_calls",
  description:
    "calls between services, one row per caller and callee a minute (the service map)",
  timeField: "ts",
  columns: [
    { name: "ts", type: "timestamp with time zone" },
    { name: "caller", type: "text" },
    { name: "callee", type: "text" },
    { name: "tier", type: "text", description: "service or store" },
    { name: "requests", type: "integer" },
    { name: "errors", type: "integer" },
    { name: "p95_ms", type: "double precision" },
  ],
};

function source(...tables: CatalogTable[]): SqlSourceConfig {
  return {
    kind: "timescaledb",
    host: "localhost",
    port: 5432,
    database: "holotable",
    schema: "metrics",
    ssl: false,
    tables,
  };
}

const SOURCES: Record<string, SqlSourceConfig> = {
  "ts-metrics": source(HTTP_REQUESTS, SERVICE_CALLS),
  "ts-system": source(SYSTEM_METRICS),
  "ts-logs": source(APP_LOGS),
  [ALLOCATIONS_SOURCE_ID]: source(...ALLOCATION_TABLES),
  // The files demo (#574): the catalog the seeder registers, which is what
  // Discover tables finds in the files it writes.
  [DEMO_FILES_SOURCE_ID]: demoFilesConfig(),
};

const TARGETS: DemoLinkTargets = { hostDetail: "00000000-0000-4000-8000-000000000001" };

const SPECS: Record<string, Dashboard> = {
  demo: parseDashboard(demoSpec()),
  fleet: parseDashboard(fleetSpec(TARGETS)),
  hostDetail: parseDashboard(hostDetailSpec()),
  files: parseDashboard(demoFilesSpec(TARGETS)),
  allocations: parseDashboard(allocationsSpec()),
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
  const links = [SPECS.fleet, SPECS.files]
    .flatMap((spec) => spec?.panels ?? [])
    .flatMap((panel) => (panel.links ?? []).filter((link) => !isSelfLink(link)));
  assert.ok(links.length >= 4, "the fleet and files dashboards link out");
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

test("the network topology is a directed graph whose hosts, and only they, open host detail (#624)", () => {
  const panel = SPECS.files?.panels.find((p) => p.id === "network");
  assert.ok(panel);
  // The hosts it names are the inventory's, and host detail's picker's.
  const inventory = DEMO_HOSTS.map(([host]) => host);
  assert.deepEqual(inventory, HOSTS);
  // The rows as the panel's SQL returns them: the links, each child joined
  // to the inventory, so only a host has a `host`.
  const data = {
    columns: ["parent", "child", "tier", "bandwidth_gbps", "host", "role"],
    rows: DEMO_LINKS.map(([parent, child, tier, gbps]) => {
      const host = DEMO_HOSTS.find(([h]) => h === child);
      return {
        parent,
        child,
        tier,
        bandwidth_gbps: gbps,
        host: host?.[0] ?? null,
        role: host?.[2] ?? null,
      };
    }),
  };
  const view = graphView(panel, data);
  assert.ok(view.layout === "dag" && view.fallback === undefined);
  // Dual-homed hosts have two parents, and the core routers loop.
  assert.deepEqual(view.net.nodes.find((n) => n.id === "host-02")?.parents, [
    "access-1",
    "access-2",
  ]);
  const targets = { [TARGETS.hostDetail]: { title: "Demo host detail" } };
  const context = {
    timeRange: SPECS.files?.timeRange ?? { from: "now-1h", to: "now" },
    selection: {},
  };
  for (const node of view.net.nodes) {
    const items = datumLinkItems(panel, targets, context, graphDatum(node));
    if (!inventory.includes(node.id)) {
      assert.deepEqual(items, [], `${node.id} offers no link`);
      continue;
    }
    assert.equal(items.length, 1, node.id);
    const item = items[0];
    assert.ok(item?.kind === "navigate");
    assert.match(
      item.href,
      new RegExp(`^/dashboards/${TARGETS.hostDetail}\\?.*host=${node.id}`),
    );
  }
  // The loop's edge back keeps its real ends when clicked.
  const back = graphClickDatum(panel, data, graphEdgeId("core-2", "core-1"));
  assert.equal(back?.row.source, "core-2");
  assert.equal(back?.row.target, "core-1");
  assert.equal(back?.row.value, 400);
});

test("the request flow is a Sankey whose services, and only they, show that service (#625)", () => {
  const panel = SPECS.demo?.panels.find((p) => p.id === "request-flow");
  assert.ok(panel?.viz === "sankey");
  // It answers to the service picker, as every http_requests panel does.
  assert.match(queryOf(panel).sql, /service = ANY\(:service\)/);
  const data = {
    columns: ["period", "service", "route", "status", "requests"],
    rows: [
      { period: "t1", service: "api", route: "/login", status: "200", requests: 9 },
      { period: "t1", service: "web", route: "/login", status: "500", requests: 1 },
    ],
  };
  const net = sankeyNet(panel, data);
  assert.equal(net.problem, undefined);
  const context = {
    timeRange: SPECS.demo?.timeRange ?? { from: "now-1h", to: "now" },
    selection: {},
  };
  const offers = (datum: Parameters<typeof datumLinkItems>[3]) =>
    datumLinkItems(panel, {}, context, datum).length;
  for (const node of net.nodes) {
    const isService = node.id.startsWith("0\u001f");
    assert.equal(offers(graphDatum(node)), isService ? 1 : 0, node.name);
  }
  // A band leaving a service carries it; a band from a route to a status does not.
  for (const edge of net.edges) {
    const datum = sankeyClickDatum(panel, data, edge.id);
    assert.ok(datum);
    assert.equal(offers(datum), edge.source.startsWith("0\u001f") ? 1 : 0, edge.id);
  }
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
  assert.ok(visuals.length >= 1, "the demo shows a custom visual");
  for (const panel of visuals) {
    const result = await compileVegaLite((panel.options as { spec: unknown }).spec);
    assert.ok(result.ok, `${panel.id}: ${result.ok ? "" : result.error}`);
  }
});

test("between them, the four default dashboards show every panel kind", () => {
  // What a default install opens on: the files demo, like the PromQL and
  // LogQL self-monitoring, is opt-in, so a kind shown only there is a kind a
  // first look never sees.
  const defaults = [SPECS.demo, SPECS.fleet, SPECS.hostDetail, selfMonitoringSpec()];
  const used = new Set(defaults.flatMap((spec) => spec.panels.map((p) => p.viz)));
  assert.deepEqual(
    PANEL_KIND_NAMES.filter((kind) => !used.has(kind)),
    [],
    "add a panel of each missing kind to a default demo dashboard",
  );
});

test("the seeded dashboards and the retired ones never share a title", () => {
  const titles = Object.values(SPECS).map((spec) => spec.title);
  for (const retired of RETIRED_DEMO_DASHBOARDS) {
    assert.ok(!titles.includes(retired), retired);
  }
});

test("the staffing demo has everyone every week, and actuals only for past weeks", () => {
  // A Wednesday afternoon: its week started on Monday the 19th.
  const now = Date.parse("2026-10-21T15:30:00Z");
  const thisWeek = weekStart(now);
  assert.equal(new Date(thisWeek).toISOString(), "2026-10-19T00:00:00.000Z");
  const rows = allocationRows(now);
  const people = new Set(PEOPLE.map(([person]) => person));
  const projects = new Set(PROJECTS.map(([project]) => project));
  const weeks = new Map<number, Set<string>>();
  const keys = new Set<string>();
  for (const row of rows) {
    const week = row.week.getTime();
    const key = `${week}:${row.person}:${row.project}`;
    assert.ok(!keys.has(key), `one row per person, project and week: ${key}`);
    keys.add(key);
    assert.equal(weekStart(week), week, "a week is a Monday at 00:00 UTC");
    assert.ok(people.has(row.person), row.person);
    assert.ok(projects.has(row.project), row.project);
    assert.equal(row.actual_hours === null, week >= thisWeek);
    weeks.set(week, (weeks.get(week) ?? new Set()).add(row.person));
  }
  // Every person has a row every week, so the status grid shows everyone.
  assert.equal(weeks.size, ALLOCATION_WEEKS_BACK + 1 + ALLOCATION_WEEKS_AHEAD);
  for (const present of weeks.values()) assert.equal(present.size, people.size);
  // The same week writes the same rows.
  assert.deepEqual(allocationRows(now + 3_600_000), rows);
});
