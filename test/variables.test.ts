import { before, test } from "node:test";
import { sqlPlanOf } from "./support/plans";
import assert from "node:assert/strict";
import { loadModule } from "libpg-query";
import { HttpError } from "@/lib/auth/authorize";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { Dashboard, type Variable } from "@/lib/ir";
import { getPoller, type PanelExecutor } from "@/lib/poller/registry";
import {
  type SqlSourceConfig,
  type SqlSourceRecord,
  TimescaleDbConfig,
} from "@/lib/registry";
import type { ExecutablePlan } from "@/lib/sql/safety";
import {
  resolveSelection,
  type Selection,
  selectionFromParams,
  selectionParams,
  valuesKey,
  VariableSelectionError,
} from "@/lib/variable-selection";
import { checkedSelection, type VariableDeps, variableOptions } from "@/lib/variables";

/** Dashboard variables (#67): declaration, selection, allowed values, saving. */

before(async () => {
  await loadModule();
});

const config = TimescaleDbConfig.parse({
  host: "db",
  port: 5432,
  database: "metrics",
  schema: "metrics",
  tables: [
    {
      name: "m",
      timeField: "ts",
      columns: [
        { name: "ts", type: "timestamptz" },
        { name: "host", type: "text" },
        { name: "tenant", type: "text" },
        { name: "v", type: "integer" },
      ],
    },
  ],
});

function source(id: string, extra: Partial<SqlSourceRecord> = {}): SqlSourceRecord {
  return {
    id,
    workspaceId: "ws",
    name: id,
    kind: "timescaledb",
    config,
    secretRef: "TS",
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "o",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tombstonedAt: null,
    ...extra,
  } as SqlSourceRecord;
}

const ENV: Variable = { name: "env", type: "enum", values: ["prod", "staging"] };
const HOSTS: Variable = {
  name: "host",
  type: "query",
  query: { sourceId: "src", sql: "SELECT DISTINCT host FROM m ORDER BY 1" },
  multi: true,
};

function spec(extra: Record<string, unknown> = {}) {
  return {
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 60_000,
    variables: [ENV, HOSTS],
    panels: [
      {
        id: "p",
        title: "p",
        viz: "line",
        query: {
          sourceId: "src",
          sql: "SELECT ts, v FROM m WHERE host = ANY(:host) AND tenant = :env",
          timeField: "ts",
        },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
    ...extra,
  };
}

test("a declaration is checked: its kind, its values, its default, its name", () => {
  assert.ok(Dashboard.safeParse(spec()).success);
  const refused: [unknown, RegExp][] = [
    [{ name: "Host", type: "enum", values: ["a"] }, /lowercase/],
    [{ name: "host", type: "enum" }, /lists "values"/],
    [{ name: "host", type: "query", values: ["a"] }, /has a "query"/],
    [{ name: "host", type: "enum", values: ["a", "a"] }, /unique/],
    [{ name: "host", type: "enum", values: ["a"], default: "b" }, /one of the values/],
    [{ name: "host", type: "enum", values: ["a"], default: ["a"] }, /only a "multi"/],
    [{ name: "host", type: "enum", values: [""] }, /too_small|at least|>=1/i],
  ];
  for (const [variable, message] of refused) {
    const result = Dashboard.safeParse(spec({ variables: [variable] }));
    assert.equal(result.success, false, JSON.stringify(variable));
    assert.match(
      result.error?.issues.map((i) => `${i.code} ${i.message}`).join("\n") ?? "",
      message,
      JSON.stringify(variable),
    );
  }
  const twice = Dashboard.safeParse(spec({ variables: [ENV, ENV] }));
  assert.match(twice.error?.issues[0].message ?? "", /duplicate variable "env"/);
});

test("picks travel as var-* parameters and come back the same", () => {
  const params = new URLSearchParams(
    selectionParams({ host: ["a", "b"], env: ["prod"] }).map(([k, v]) => [k, v]),
  );
  assert.equal(params.toString(), "var-host=a&var-host=b&var-env=prod");
  assert.deepEqual(selectionFromParams(params), { host: ["a", "b"], env: ["prod"] });
  assert.deepEqual(
    selectionFromParams({ "var-env": "prod", from: "now-1h", "var-host": ["a", "b"] }),
    { env: ["prod"], host: ["a", "b"] },
  );
  assert.equal(valuesKey({ a: "1", b: ["2"] }), valuesKey({ b: ["2"], a: "1" }));
  assert.notEqual(valuesKey({ a: "1" }), valuesKey({ a: ["1"] }));
});

test("a pick must be one the variable allows; no pick is the default", async () => {
  const options = async (v: Variable) =>
    v.name === "host" ? ["h1", "h2"] : (v.values ?? []);
  const variables = [ENV, HOSTS];
  assert.deepEqual(await resolveSelection(variables, {}, options), {
    env: "prod",
    host: ["h1"],
  });
  assert.deepEqual(
    await resolveSelection(
      variables,
      { env: ["staging"], host: ["h2", "h1", "h2"] },
      options,
    ),
    { env: "staging", host: ["h2", "h1"] },
  );
  // A name nothing declares is never bound.
  assert.deepEqual(await resolveSelection(variables, { other: ["x"] }, options), {
    env: "prod",
    host: ["h1"],
  });
  const refusedPicks: Selection[] = [
    { env: ["dev"] },
    { env: ["prod", "staging"] },
    { host: ["h3"] },
    { host: ["h1", "'; DROP TABLE m; --"] },
  ];
  for (const picks of refusedPicks) {
    await assert.rejects(
      resolveSelection(variables, picks, options),
      VariableSelectionError,
    );
  }
  const empty = async () => [];
  await assert.rejects(
    resolveSelection([{ ...HOSTS, multi: false }], {}, empty),
    /offers none and has no default/,
  );
  assert.deepEqual(
    await resolveSelection([{ ...HOSTS, multi: false, default: "h9" }], {}, empty),
    { host: "h9" },
    "an authored default stands",
  );
});

function deps(rows: Record<string, unknown>[], sources: Record<string, SqlSourceRecord>) {
  const plans: ExecutablePlan[] = [];
  const d: VariableDeps = {
    getSource: async (id) => sources[id] ?? null,
    execute: async (_source, plan) => {
      plans.push(sqlPlanOf(plan));
      return { columns: ["host"], rows };
    },
  };
  return { d, plans };
}

test("a query variable's values come from its guarded query, in its workspace only", async () => {
  const { d, plans } = deps(
    [{ host: "h1" }, { host: "h2" }, { host: "h1" }, { host: null }, { host: 7 }],
    { src: source("src") },
  );
  assert.deepEqual(await variableOptions(HOSTS, "ws", {}, d), ["h1", "h2", "7"]);
  assert.match(
    plans[0].sql,
    /^SELECT \* FROM \(SELECT DISTINCT host FROM m ORDER BY 1\) AS _holo LIMIT/,
  );
  assert.deepEqual(plans[0].params, []);

  assert.deepEqual(await variableOptions(ENV, "ws", {}, d), ["prod", "staging"]);

  const elsewhere = deps([], { src: source("src", { workspaceId: "other" }) });
  await assert.rejects(variableOptions(HOSTS, "ws", {}, elsewhere.d), /not available/);
  const gone = deps([], {
    src: source("src", { tombstonedAt: new Date().toISOString() }),
  });
  await assert.rejects(variableOptions(HOSTS, "ws", {}, gone.d), /not available/);

  const sneaky: Variable = {
    ...HOSTS,
    query: { sourceId: "src", sql: "SELECT host FROM m WHERE host = :host" },
  };
  await assert.rejects(variableOptions(sneaky, "ws", {}, d), /undeclared variable :host/);
  const forbidden: Variable = {
    ...HOSTS,
    query: { sourceId: "src", sql: "SELECT usename FROM pg_catalog.pg_user" },
  };
  await assert.rejects(variableOptions(forbidden, "ws", {}, d), /allowlist/);
});

test("a row-filtered source offers only the viewer's values", async () => {
  const filtered = source("src", {
    config: TimescaleDbConfig.parse({
      ...config,
      rowFilter: { column: "tenant", claim: "tenant" },
    }),
  });
  const { d, plans } = deps([{ host: "h1" }], { src: filtered });
  await variableOptions(HOSTS, "ws", { tenant: "acme" }, d);
  assert.match(plans[0].sql, /_holo_rf\.tenant = \$1/);
  assert.deepEqual(plans[0].params, ["acme"]);
  await assert.rejects(
    checkedSelection([HOSTS], {}, "ws", {}, d),
    (err: unknown) => err instanceof HttpError && err.status === 403,
  );
});

test("a refused pick is a 400 the viewer can act on", async () => {
  const { d } = deps([{ host: "h1" }], { src: source("src") });
  await assert.rejects(
    checkedSelection([HOSTS], { host: ["nope"] }, "ws", {}, d),
    (err: unknown) => err instanceof HttpError && err.status === 400,
  );
  assert.deepEqual(await checkedSelection(undefined, { host: ["x"] }, "ws", {}, d), {});
});

test("saving: references must be declared, and a variable's query is held to a panel's rules", async () => {
  const sources: Record<string, SqlSourceRecord> = {
    src: source("src"),
    far: source("far", { workspaceId: "other" }),
  };
  const getSource = async (id: string) => sources[id] ?? null;
  const ok = await resolveAndValidateDashboard(Dashboard.parse(spec()), getSource);
  assert.equal(ok.workspaceId, "ws");

  await assert.rejects(
    resolveAndValidateDashboard(Dashboard.parse(spec({ variables: [HOSTS] })), getSource),
    /undeclared variable :env/,
  );
  await assert.rejects(
    resolveAndValidateDashboard(
      Dashboard.parse(
        spec({
          variables: [ENV, { ...HOSTS, query: { ...HOSTS.query, sourceId: "far" } }],
        }),
      ),
      getSource,
    ),
    /outside the dashboard's workspace/,
  );
  await assert.rejects(
    resolveAndValidateDashboard(
      Dashboard.parse(
        spec({
          variables: [
            ENV,
            { ...HOSTS, query: { sourceId: "src", sql: "SELECT host FROM m; SELECT 1" } },
          ],
        }),
      ),
      getSource,
    ),
    /variable "host"/,
  );
});

test("viewers with different picks get different pollers, each bound with its own", async () => {
  const seen: unknown[] = [];
  const executor: PanelExecutor = async (panel, _w, _ws, _scope, variables) => {
    seen.push(variables);
    return [{ type: "panel", panelId: panel.id, mode: "replace", columns: [], rows: [] }];
  };
  const dashboard = Dashboard.parse(spec());
  const a = getPoller("dash-vars", 1, "ws", dashboard, {}, executor, {
    env: "prod",
    host: ["h1"],
  });
  const b = getPoller("dash-vars", 1, "ws", dashboard, {}, executor, {
    env: "staging",
    host: ["h1"],
  });
  const a2 = getPoller("dash-vars", 1, "ws", dashboard, {}, executor, {
    host: ["h1"],
    env: "prod",
  });
  assert.notEqual(a, b);
  assert.equal(a, a2, "the same picks share one");
  const stopA = a.subscribe(() => {});
  const stopB = b.subscribe(() => {});
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [
    { env: "prod", host: ["h1"] },
    { env: "staging", host: ["h1"] },
  ]);
  stopA();
  stopB();
});
