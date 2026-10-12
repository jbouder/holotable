import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { buildChatQueryPlan, buildSystemPrompt } from "@/lib/ai/chat";
import { buildDataChatPrompt, chatPanelSchema, chatQueryOf } from "@/lib/ai/data-chat";
import {
  baseSystem,
  dashboardRequest,
  explorePanelRequest,
  LOGQL_RULES,
  PROMQL_RULES,
  queryRules,
  vizGuide,
} from "@/lib/ai/generate";
import { wrongLanguages } from "@/lib/ai/source-languages";
import {
  logqlStreamOf,
  recordedLogqlDashboard,
  recordedLogqlExplorePanel,
} from "@/lib/ai/stub";
import type { Identity } from "@/lib/auth/claims";
import { Dashboard, type Panel, SPEC_VERSION } from "@/lib/ir";
import { validateLogql } from "@/lib/logql/safety";
import { logs } from "@/lib/panels/kinds/logs";
import type { SourceRecord } from "@/lib/registry";
import { serverKind } from "@/lib/sources/server/registry";
import { loadSource } from "../scripts/lib/eval";

/**
 * Generation, Explore and chat write LogQL (#564): a Loki source's prompt
 * carries the LogQL rules and the logs kind's LogQL hint, the schema holds a
 * panel to LogQL, the stub answers with a logs panel and a rate panel, and
 * chat runs LogQL. The SQL and PromQL prompts are held byte for byte in
 * `test/promql-generation.test.ts`.
 */

const loki = loadSource("loki-demo");
const prom = loadSource("prometheus-demo");
const sql = loadSource("demo");
const catalog = { labels: "labels" in loki.config ? loki.config.labels : [] };

test("a Loki generation is told the LogQL rules, the logs kind's LogQL hint and label variables", () => {
  const system = baseSystem(loki);
  assert.ok(system.includes(LOGQL_RULES));
  assert.ok(!system.includes("SQL rules (STRICT)"));
  assert.ok(!system.includes(PROMQL_RULES));
  assert.match(
    system,
    /only a viz specification \(a SQL, PromQL or LogQL query \+ layout\)/,
  );
  assert.ok(system.includes(`- 'logs': ${logs.logqlHint}`));
  // A metric query answers in PromQL's shape, so the other kinds say so.
  assert.match(system, /- 'stat': an instant query \('instant': true\)/);
  assert.match(system, /"label":"app","match":"\{env=\\"prod\\"\}"/);
  // The catalog names labels and their values, never the URL.
  assert.match(system, /\(id: eval-loki-demo, kind: loki\)/);
  assert.match(system, /^- level -- values seen: debug, info, warn, error$/m);
  assert.ok(!system.includes("http://loki:3100"));
  assert.doesNotMatch(system, /\bauth\b|bearer/);
});

test("every LogQL the prompt shows the model passes the guard", () => {
  // Each example as the rules and the hint write it; a rule the guard would
  // refuse is a rule that teaches the model a refusal.
  const examples = [
    '{app="api"}',
    '{app="api"} |= "error"',
    'sum by (route) (count_over_time({app="api"} | json [5m]))',
    '{app="api"} | json | status >= 500',
    '{env=":env"}',
    '{app="api"} | level=":level"',
    '{app="api"} |= ":needle"',
  ];
  const prompt = `${LOGQL_RULES}\n${logs.logqlHint}`;
  const declared = new Set(["env", "level", "needle"]);
  for (const example of examples) {
    const shown = example.startsWith('{app="api"} ') ? example.slice(12) : example;
    assert.ok(prompt.includes(shown), `the prompt shows ${shown}`);
    const result = validateLogql(example, catalog, declared);
    assert.ok(result.ok, `${example}: ${result.error}`);
  }
  // And the variable forms it forbids are the ones the guard refuses.
  for (const refused of ['{app=~":app"}', '{app="api"} |~ ":needle"']) {
    assert.equal(validateLogql(refused, catalog, new Set(["app", "needle"])).ok, false);
  }
});

test("a mixed generation gets every rule set and the rule that a panel's language is its source's", () => {
  const rules = queryRules([sql, prom, loki]);
  assert.match(rules, /SQL rules \(STRICT\)/);
  assert.match(rules, /PromQL rules \(STRICT\)/);
  assert.match(rules, /LogQL rules \(STRICT\)/);
  assert.match(
    rules,
    /LogQL may match ONLY labels from the catalog block of THAT source/,
  );
  assert.match(
    rules,
    /'query\.sql' for a source whose\n {2}catalog says kind: timescaledb, 'query\.promql' for kind: prometheus, 'query\.logql' for kind: loki\./,
  );
  // The logs kind says each language's hint; a metric kind says PromQL's once.
  const guide = vizGuide(new Set(["sql", "promql", "logql"]));
  assert.match(
    guide,
    /- 'logs': raw events.* With PromQL: not for a Prometheus source.* With LogQL: a LogQL log query/,
  );
  assert.doesNotMatch(guide, /- 'line': .*With LogQL/);
});

test("the schema holds each panel to LogQL on a Loki source, so the repair says what to write", async () => {
  const request = dashboardRequest({
    source: loki,
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
        query: { sourceId: loki.id, sql: "SELECT 1" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  };
  assert.deepEqual(
    wrongLanguages(wrong, { [loki.id]: "logql", [sql.id]: "sql" }).map((i) => i.message),
    [
      `panel "a" queries source "${loki.id}", which answers LogQL; write "query.logql" instead of "query.sql"`,
    ],
  );
  const parsed = await (request.schema as z.ZodType).safeParseAsync(wrong);
  assert.equal(parsed.success, false);
  assert.match(JSON.stringify(parsed.error?.issues), /which answers LogQL/);
});

test("the stub answers a Loki request with a logs panel and a rate panel the guard accepts", async () => {
  const stream = logqlStreamOf(baseSystem(loki), loki.id);
  assert.deepEqual(stream, { label: "app", value: "api" });
  assert.equal(logqlStreamOf(baseSystem(prom), prom.id), null);
  assert.ok(stream);
  const dashboard = recordedLogqlDashboard(loki.id, stream);
  assert.deepEqual(
    dashboard.panels.map((p) => p.viz),
    ["logs", "line"],
  );
  const explore = recordedLogqlExplorePanel(loki.id, stream);
  for (const panel of [...dashboard.panels, explore]) {
    const check = await serverKind(loki).check(loki, panel.query, new Set());
    assert.ok(check.ok, `${panel.id}: ${check.error}`);
  }
  // Both parse as what their routes are bound to.
  const spec = Dashboard.safeParse({ ...dashboard, specVersion: SPEC_VERSION });
  assert.ok(spec.success, spec.success ? "" : JSON.stringify(spec.error.issues));
  const schema = explorePanelRequest({ source: loki, prompt: "errors" })
    .schema as z.ZodType;
  const panel = await schema.safeParseAsync(explore);
  assert.ok(panel.success, panel.success ? "" : JSON.stringify(panel.error.issues));
});

const identity = {
  sub: "u",
  groups: [],
  roles: new Map(),
  platformAdmin: false,
  attributes: {},
} as unknown as Identity;

function dashboardOver(source: SourceRecord): Dashboard {
  return Dashboard.parse({
    specVersion: SPEC_VERSION,
    title: "D",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15000,
    panels: [
      {
        id: "p",
        title: "P",
        viz: "logs",
        query: { sourceId: source.id, logql: '{app="api"}' },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      } satisfies Panel,
    ],
  });
}

test("the chat runs LogQL against a Loki source, refuses an instant log query, and draws a logs panel", async () => {
  const dashboard = dashboardOver(loki);
  const prompt = buildSystemPrompt(dashboard, [loki]);
  assert.match(prompt, /pass 'logql' instead of\n {2}'sql'/);
  assert.ok(prompt.includes(LOGQL_RULES));
  assert.ok(!buildSystemPrompt(dashboardOver(sql), [sql]).includes("LogQL rules"));
  assert.ok(
    buildDataChatPrompt({ sources: [loki], timeRange: dashboard.timeRange }).includes(
      LOGQL_RULES,
    ),
  );

  const built = await buildChatQueryPlan({
    dashboard,
    sources: [loki],
    args: { sourceId: loki.id, logql: '{app="api"} |= "error"' },
    identity,
  });
  assert.ok(built.ok, built.ok ? "" : built.error);
  assert.equal(built.plan.language, "logql");

  const instant = await buildChatQueryPlan({
    dashboard,
    sources: [loki],
    args: { sourceId: loki.id, logql: '{app="api"}', instant: true },
    identity,
  });
  assert.deepEqual(instant, {
    ok: false,
    error: "a log query runs over the dashboard's range; it cannot be an instant query",
  });
  const refused = await buildChatQueryPlan({
    dashboard,
    sources: [loki],
    args: { sourceId: loki.id, promql: "up" },
    identity,
  });
  assert.deepEqual(refused, {
    ok: false,
    error: `source "${loki.id}" answers LogQL; this query is PromQL`,
  });
  assert.deepEqual(chatQueryOf({ sourceId: loki.id, sql: "SELECT 1", logql: "{}" }), {
    ok: false,
    error: "give exactly one of sql, promql or logql",
  });

  // showPanel is bound to the LogQL-capable schema, which takes the logs panel.
  const stream = logqlStreamOf(baseSystem(loki), loki.id);
  assert.ok(stream);
  const {
    id: _id,
    layout: _layout,
    ...input
  } = recordedLogqlExplorePanel(loki.id, stream);
  const parsed = await (chatPanelSchema([loki]) as z.ZodType).safeParseAsync(input);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.issues));
});
