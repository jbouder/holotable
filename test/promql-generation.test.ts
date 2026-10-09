import { test } from "node:test";
import assert from "node:assert/strict";
import { NoObjectGeneratedError } from "ai";
import type { z } from "zod";
import { buildChatQueryPlan, buildSystemPrompt } from "@/lib/ai/chat";
import {
  baseSystem,
  dashboardRequest,
  explorePanelRequest,
  PROMQL_RULES,
  queryRules,
  SQL_RULES,
  sqlRules,
  VIZ_GUIDE,
  vizGuide,
} from "@/lib/ai/generate";
import { describeFailure } from "@/lib/ai/repair";
import { wrongLanguages } from "@/lib/ai/source-languages";
import { recordedPromqlDashboard, recordedPromqlExplorePanel } from "@/lib/ai/stub";
import type { Identity } from "@/lib/auth/claims";
import { Dashboard, DashboardGenerationSchema, type Panel, SPEC_VERSION } from "@/lib/ir";
import { validatePromql } from "@/lib/promql/safety";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { serverKind } from "@/lib/sources/server/registry";
import { loadSource } from "../scripts/lib/eval";

/**
 * Generation, Explore and chat write PromQL (#387): the prompt learns the
 * language of each source, the schema holds a panel to it, the stub answers
 * a Prometheus request with PromQL, and a SQL request is asked exactly what
 * it always was.
 */

const prom = loadSource("prometheus-demo");
const sql = loadSource("demo");

function promSource(id: string): SourceRecord {
  return { ...prom, id, name: id };
}

test("a SQL generation's prompt is what it was before PromQL existed", () => {
  assert.equal(queryRules([sql]), sqlRules(1));
  assert.equal(queryRules([sql]), SQL_RULES);
  assert.equal(vizGuide(new Set(["sql"])), VIZ_GUIDE);
  const system = baseSystem(sql);
  assert.ok(!system.includes("PromQL"));
  assert.match(system, /only a viz specification \(SQL \+ layout\)/);
  // And it is bound to the SQL schema, not the union.
  assert.equal(
    dashboardRequest({ source: sql, prompt: "x" }).schema,
    DashboardGenerationSchema,
  );
});

test("a Prometheus generation is told the PromQL rules, the kinds' PromQL hints and label variables", () => {
  const system = baseSystem(prom);
  assert.ok(system.includes(PROMQL_RULES));
  assert.ok(!system.includes("SQL rules (STRICT)"));
  assert.match(system, /only a viz specification \(a SQL or PromQL query \+ layout\)/);
  assert.match(system, /- 'stat': an instant query \('instant': true\)/);
  assert.match(system, /- 'heatmap': not for a Prometheus source/);
  assert.match(system, /"label":"instance"/);
  // The catalog names metrics with their type and labels, never the URL.
  assert.match(system, /- holotable_query_duration_seconds_bucket \(histogram\) -- /);
  assert.match(system, /labels: instance, job, le, outcome, source/);
  assert.match(system, /\(id: eval-prometheus-demo, kind: prometheus\)/);
  assert.ok(!system.includes("http://prometheus:9090"));
  assert.doesNotMatch(system, /\bauth\b|bearer/);
});

test("a mixed generation gets both rule sets and the rule that a panel's language is its source's", () => {
  const rules = queryRules([sql, prom]);
  assert.match(rules, /SQL rules \(STRICT\)/);
  assert.match(rules, /PromQL rules \(STRICT\)/);
  assert.match(rules, /Each panel's query language is its source's/);
  assert.match(
    rules,
    /PromQL may name ONLY metrics from the catalog block of THAT source/,
  );
  assert.match(
    vizGuide(new Set(["sql", "promql"])),
    /- 'line': a numeric trend over time;.* With PromQL: a range query/,
  );
});

test("the schema holds each panel to its source's language, so the repair says what to write", () => {
  const request = dashboardRequest({
    source: prom,
    additionalSources: [sql],
    prompt: "x",
  });
  const wrong = {
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "a",
        title: "A",
        viz: "table",
        query: { sourceId: prom.id, sql: "SELECT 1" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
      {
        id: "b",
        title: "B",
        viz: "stat",
        query: { sourceId: sql.id, promql: "up", instant: true },
        layout: { x: 6, y: 0, w: 6, h: 4 },
      },
    ],
  };
  assert.deepEqual(
    wrongLanguages(wrong, { [prom.id]: "promql", [sql.id]: "sql" }).map((i) => i.message),
    [
      `panel "a" queries source "${prom.id}", which answers PromQL; write "query.promql" instead of "query.sql"`,
      `panel "b" queries source "${sql.id}", which answers SQL; write "query.sql" instead of "query.promql"`,
    ],
  );
  const error = new NoObjectGeneratedError({
    message: "no object",
    text: JSON.stringify(wrong),
    response: { id: "r", timestamp: new Date(), modelId: "m" },
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputTokenDetails: {} as never,
      outputTokenDetails: {} as never,
    },
    finishReason: "stop",
  });
  const failure = describeFailure(error, request.schema as z.ZodType);
  assert.ok(failure);
  assert.match(failure.issues.join("\n"), /which answers PromQL; write "query.promql"/);
});

test("the stub answers a Prometheus request with PromQL the guard accepts", () => {
  const catalog = prom.config;
  assert.ok("metrics" in catalog);
  const dashboard = recordedPromqlDashboard(prom.id);
  for (const panel of [...dashboard.panels, recordedPromqlExplorePanel(prom.id)]) {
    const result = validatePromql(panel.query.promql, catalog);
    assert.ok(result.ok, `${panel.id}: ${result.error}`);
  }
  assert.ok(Dashboard.safeParse({ ...dashboard, specVersion: SPEC_VERSION }).success);
});

test("Explore over a Prometheus source is bound to the PromQL-capable panel schema", () => {
  const request = explorePanelRequest({ source: prom, prompt: "p95 latency" });
  const parsed = (request.schema as z.ZodType).safeParse(
    recordedPromqlExplorePanel(prom.id),
  );
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});

const identity = {
  sub: "u",
  groups: [],
  roles: new Map(),
  platformAdmin: false,
  attributes: {},
} as unknown as Identity;

function dashboardOver(sourceId: string): Dashboard {
  return Dashboard.parse({
    specVersion: SPEC_VERSION,
    title: "D",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "p",
        title: "P",
        viz: "stat",
        query: { sourceId, promql: "sum(holotable_pollers_active)", instant: true },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      } satisfies Panel,
    ],
  });
}

test("the chat runs PromQL against a Prometheus source, and refuses SQL there by name", async () => {
  const source = promSource("prom-chat");
  const dashboard = dashboardOver(source.id);
  assert.match(
    buildSystemPrompt(dashboard, [source]),
    /pass 'promql' instead of\n {2}'sql'/,
  );
  assert.ok(!buildSystemPrompt(dashboardOver("x"), [sql]).includes("PromQL rules"));

  const built = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: { sourceId: source.id, promql: "sum(holotable_pollers_active)", instant: true },
    identity,
  });
  assert.ok(built.ok, built.ok ? "" : built.error);
  assert.equal(built.plan.language, "promql");

  const refused = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: { sourceId: source.id, sql: "SELECT 1" },
    identity,
  });
  assert.deepEqual(refused, {
    ok: false,
    error: `source "${source.id}" answers PromQL; this query is SQL`,
  });
  const both = await buildChatQueryPlan({
    dashboard,
    sources: [source],
    args: { sourceId: source.id, sql: "SELECT 1", promql: "up" },
    identity,
  });
  assert.deepEqual(both, { ok: false, error: "give exactly one of sql or promql" });
});

test("the eval catalog is a valid Prometheus config whose renderCatalog the prompt carries", () => {
  assert.ok(SourceConfig.safeParse(prom.config).success);
  assert.match(serverKind(prom).renderCatalog(prom), /^Source: prometheus-demo/);
});
