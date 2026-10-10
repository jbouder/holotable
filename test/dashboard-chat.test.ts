import { test } from "node:test";
import { sqlPlanOf } from "./support/plans";
import assert from "node:assert/strict";
import { buildChatQueryPlan, buildSystemPrompt, resolveChatView } from "@/lib/ai/chat";
import type { VariableValues } from "@/lib/sql/variables";
import type { Selection } from "@/lib/variable-selection";
import { parseGroups } from "@/lib/auth/claims";
import {
  type SqlSourceConfig,
  type SqlSourceRecord,
  TimescaleDbConfig,
} from "@/lib/registry";
import type { Dashboard } from "@/lib/ir";

const reader = parseGroups("reader", ["/workspaces/ws/viewer"]);

const config = TimescaleDbConfig.parse({
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
        { name: "duration_ms", type: "double precision" },
      ],
    },
  ],
});

const source: SqlSourceRecord = {
  id: "src-metrics",
  workspaceId: "ws-1",
  name: "Metrics",
  kind: "timescaledb",
  config,
  secretRef: "TS_METRICS",
  catalogRefreshedAt: new Date().toISOString(),
  catalogMissingTables: [],
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
};

const dashboard = {
  title: "Traffic",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 15_000,
  panels: [],
} as unknown as Dashboard;

test("rejects a source not available on the dashboard", async () => {
  const r = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    identity: reader,
    args: { sourceId: "src-other", sql: "SELECT count(*) FROM http_requests" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /src-metrics/);
});

test("rejects non-SELECT SQL", async () => {
  const r = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    identity: reader,
    args: { sourceId: "src-metrics", sql: "DELETE FROM http_requests" },
  });
  assert.equal(r.ok, false);
});

test("rejects a table not in the source allowlist", async () => {
  const r = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    identity: reader,
    args: { sourceId: "src-metrics", sql: "SELECT * FROM secrets" },
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /allowlist/);
});

test("builds a guarded plan with server-injected time range for time-series", async () => {
  const now = new Date("2026-07-11T12:00:00.000Z");
  const r = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    identity: reader,
    args: {
      sourceId: "src-metrics",
      sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS c FROM http_requests GROUP BY minute ORDER BY minute",
      timeField: "minute",
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    // The server owns the window: exactly the two bound time params are injected.
    assert.equal(sqlPlanOf(r.plan).params.length, 2);
    assert.match(sqlPlanOf(r.plan).sql, /_holo/);
    assert.match(sqlPlanOf(r.plan).sql, /_holo\.minute >= \$1::timestamptz/);
    assert.match(sqlPlanOf(r.plan).sql, /LIMIT/);
    assert.equal(r.source.id, "src-metrics");
    void now;
  }
});

test("builds a plan with no time filter when timeField is omitted (scalar)", async () => {
  const r = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    identity: reader,
    args: {
      sourceId: "src-metrics",
      sql: "SELECT count(*) AS total FROM http_requests",
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(sqlPlanOf(r.plan).params.length, 0);
    assert.doesNotMatch(sqlPlanOf(r.plan).sql, /timestamptz/);
    assert.match(sqlPlanOf(r.plan).sql, /LIMIT/);
  }
});

/* What the reader has on screen (#366) ------------------------------------ */

const withVariables = {
  ...dashboard,
  panels: [
    {
      id: "p-errors",
      title: "Error rate",
      viz: "line",
      query: {
        sourceId: "src-metrics",
        sql: "SELECT ts, count(*) AS c FROM http_requests WHERE status = :status GROUP BY ts",
        timeField: "ts",
      },
      layout: { x: 0, y: 0, w: 6, h: 4 },
    },
  ],
  variables: [{ name: "status", type: "enum", values: ["200", "500"], default: "200" }],
} as unknown as Dashboard;

/** The stream's allowlist, as a fake: only listed values pass. */
async function allowlist(picks: Selection): Promise<VariableValues> {
  const status = picks.status?.[0] ?? "200";
  if (!["200", "500"].includes(status)) throw new Error("not a value of :status");
  return { status };
}

test("the turn runs over the range the reader picked, not the saved one", async () => {
  const { dashboard: viewed, view } = await resolveChatView({
    dashboard: withVariables,
    timeRange: { from: "now-7d", to: "now" },
    picks: { status: ["500"] },
    check: allowlist,
  });
  assert.deepEqual(viewed.timeRange, { from: "now-7d", to: "now" });
  assert.deepEqual(view.variables, { status: "500" });
  assert.equal(view.picksRefused, false);
  // The stored spec is not changed.
  assert.deepEqual(withVariables.timeRange, { from: "now-1h", to: "now" });
});

test("no range sent is the dashboard's own range", async () => {
  const { dashboard: viewed } = await resolveChatView({
    dashboard: withVariables,
    picks: {},
    check: allowlist,
  });
  assert.deepEqual(viewed.timeRange, withVariables.timeRange);
});

test("a pick the reader may not use falls back to the defaults, and says so", async () => {
  const { view } = await resolveChatView({
    dashboard: withVariables,
    picks: { status: ["'; DROP TABLE x; --"] },
    check: allowlist,
  });
  assert.deepEqual(view.variables, { status: "200" });
  assert.equal(view.picksRefused, true);
  const prompt = buildSystemPrompt(withVariables, [source], view);
  assert.match(prompt, /DEFAULTS/);
});

test("when even the defaults cannot be checked, the stored defaults are used", async () => {
  const { view } = await resolveChatView({
    dashboard: withVariables,
    picks: {},
    check: async () => {
      throw new Error("options would not load");
    },
  });
  assert.deepEqual(view.variables, { status: "200" });
  assert.equal(view.picksRefused, false);
});

test("a panel id that is not on the dashboard is ignored", async () => {
  const on = await resolveChatView({
    dashboard: withVariables,
    picks: {},
    panelId: "p-errors",
    check: allowlist,
  });
  assert.equal(on.view.focusPanelId, "p-errors");
  const off = await resolveChatView({
    dashboard: withVariables,
    picks: {},
    panelId: "p-elsewhere",
    check: allowlist,
  });
  assert.equal(off.view.focusPanelId, undefined);
});

test("the prompt names the reader's range, fences their values, and the panel asked about", async () => {
  const { dashboard: viewed, view } = await resolveChatView({
    dashboard: withVariables,
    timeRange: { from: "now-7d", to: "now" },
    picks: { status: ["500"] },
    panelId: "p-errors",
    check: allowlist,
  });
  const prompt = buildSystemPrompt(viewed, [source], view);
  assert.match(prompt, /reader is viewing \(fixed by the server\): now-7d -> now/);
  assert.match(prompt, /BEGIN VARIABLES \w+ =====\nstatus = 500\n===== END VARIABLES/);
  assert.match(prompt, /asking about panel "p-errors" \(Error rate\)/);
});

test("the reader's picks are bound as parameters, never written into the SQL", async () => {
  const r = await buildChatQueryPlan({
    dashboard: withVariables,
    sources: [source],
    identity: reader,
    variables: { status: "500" },
    args: {
      sourceId: "src-metrics",
      sql: "SELECT count(*) AS c FROM http_requests WHERE status = :status",
    },
  });
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.ok(sqlPlanOf(r.plan).params.includes("500"));
    assert.doesNotMatch(sqlPlanOf(r.plan).sql, /= ?.?500\b/);
  }
});

test("a range the server cannot resolve is refused, not thrown", async () => {
  const r = await buildChatQueryPlan({
    dashboard: { ...dashboard, timeRange: { from: "now", to: "now-1h" } },
    sources: [source],
    identity: reader,
    args: {
      sourceId: "src-metrics",
      sql: "SELECT time_bucket('1 minute', ts) AS minute, count(*) AS c FROM http_requests GROUP BY minute",
      timeField: "minute",
    },
  });
  assert.equal(r.ok, false);
});

test("the dashboard chat's prompt carries the workspace's context (#66)", () => {
  const prompt = buildSystemPrompt(dashboard, [source], undefined, {
    glossary: "SLO: the target we promise",
    metricDefinitions: [],
    examples: [],
  });
  assert.match(prompt, /WORKSPACE_CONTEXT/);
  assert.match(prompt, /SLO: the target we promise/);
  assert.doesNotMatch(buildSystemPrompt(dashboard, [source]), /WORKSPACE_CONTEXT/);
});
