import { isSqlQuery } from "@/lib/ir";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APICallError } from "ai";
import {
  caseRequest,
  EVALS_DIR,
  type EvalCase,
  grade,
  loadCases,
  loadRecording,
  loadSource,
  replayModel,
  requestDigest,
  runCase,
} from "../scripts/lib/eval";
import { PROVIDER_OPTIONS } from "@/lib/ai/provider";
import { recordedDashboard, recordedExplorePanel } from "@/lib/ai/stub";
import type { Panel } from "@/lib/ir";

/*
 * The eval harness (#24) itself: the corpus loads, the grader catches each
 * kind of failure it claims to, and replay drives the real request path.
 * Whether the recorded answers pass is `npm run eval`, not this.
 */

const source = loadSource("demo");

function dashboardCase(expect: EvalCase["expect"] = {}): EvalCase {
  return { name: "t", mode: "dashboard", catalog: "demo", prompt: "x", expect };
}

function exploreCase(expect: EvalCase["expect"] = {}): EvalCase {
  return { name: "t", mode: "explore", catalog: "demo", prompt: "x", expect };
}

const good = () => recordedDashboard(source.id) as unknown as { panels: Panel[] };

test("every corpus case loads, and its catalog is a valid source", () => {
  const cases = loadCases();
  assert.ok(cases.length >= 8, `only ${cases.length} cases`);
  for (const c of cases) loadSource(c.catalog);
});

test("every recording parses and belongs to a case", () => {
  const names = new Set(loadCases().map((c) => c.name));
  for (const file of readdirSync(join(EVALS_DIR, "recordings"))) {
    if (!file.endsWith(".json")) continue;
    const name = file.slice(0, -".json".length);
    assert.ok(names.has(name), `evals/recordings/${file} has no case`);
    assert.ok(loadRecording(name));
  }
});

test("a sound dashboard passes the hard checks", async () => {
  assert.deepEqual(await grade(dashboardCase(), source, good()), []);
});

test("SQL the guard refuses fails the case, as a save would", async () => {
  const spec = good();
  const query = spec.panels[0].query;
  if (!query || !isSqlQuery(query)) throw new Error("fixture has no SQL query");
  query.sql = "SELECT * FROM pg_shadow";
  const failures = await grade(dashboardCase(), source, spec);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /rejected on save/);
});

test("a panel naming another source fails", async () => {
  const spec = recordedDashboard("somewhere-else") as unknown as { panels: Panel[] };
  const failures = await grade(dashboardCase(), source, spec);
  assert.match(failures.join("\n"), /unknown source/);
});

test("a timeField the query does not return fails", async () => {
  const spec = good();
  const query = spec.panels[0].query;
  if (!query || !isSqlQuery(query)) throw new Error("fixture has no SQL query");
  query.timeField = "ts";
  const failures = await grade(dashboardCase(), source, spec);
  assert.match(failures.join("\n"), /does not return a column called "ts"/);
});

test("the case's expectations: viz, tables, timeField, panel count", async () => {
  const failures = await grade(
    dashboardCase({
      plausibleViz: ["line", "area"],
      requiredViz: ["stat"],
      tables: ["system_metrics"],
      timeField: "required",
      minPanels: 3,
    }),
    source,
    good(),
  );
  assert.deepEqual(failures, [
    'panel "by-route" is a table; expected one of line, area',
    "no stat panel",
    "no panel reads system_metrics",
    'panel "by-route" has no timeField',
    "2 panels; expected at least 3",
  ]);
  assert.deepEqual(
    await grade(exploreCase({ timeField: "absent" }), source, good().panels[0]),
    ['panel "requests" sets timeField "minute"'],
  );
});

test("replay drives the real request path and grades the answer", async () => {
  const [c] = loadCases().filter((x) => x.mode === "explore");
  const text = JSON.stringify(recordedExplorePanel(source.id));
  const result = await runCase(
    { ...c, expect: {} },
    source,
    replayModel({ model: "m", recordedAt: "", requestDigest: "", text }),
  );
  assert.deepEqual(result.failures, []);
  assert.equal(result.text, text);
  assert.match(result.requestDigest, /^[0-9a-f]{64}$/);
});

test("an answer that is not the schema fails with the issues", async () => {
  const [c] = loadCases().filter((x) => x.mode === "dashboard");
  const result = await runCase(
    c,
    source,
    replayModel({ model: "m", recordedAt: "", requestDigest: "", text: '{"title": 1}' }),
  );
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /does not match the schema: title/);
});

test("a provider failure is a failed case, not a crash", async () => {
  const [c] = loadCases();
  const failing = {
    specificationVersion: "v4",
    provider: "x",
    modelId: "x",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("unused")),
    doStream: () =>
      Promise.reject(
        new APICallError({
          message: "gone",
          url: "u",
          requestBodyValues: {},
          statusCode: 410,
        }),
      ),
  } satisfies Parameters<typeof runCase>[2];
  const result = await runCase(c, source, failing);
  assert.equal(result.ok, false);
  assert.match(result.failures[0], /gone/);
  // Never recorded: partial text from a failed call is not an answer.
  assert.equal(result.completed, false);
});

test("the request digest is stable across calls despite the random fence tokens", () => {
  const [c] = loadCases();
  assert.equal(
    requestDigest(caseRequest(c, source)),
    requestDigest(caseRequest(c, source)),
  );
});

test("a case is asked with the provider options every app call carries", async () => {
  const [c] = loadCases();
  let seen: unknown;
  const capturing = {
    specificationVersion: "v4",
    provider: "x",
    modelId: "x",
    supportedUrls: {},
    doGenerate: () => Promise.reject(new Error("unused")),
    doStream: (options: { providerOptions?: unknown }) => {
      seen = options.providerOptions;
      return Promise.reject(new Error("stop"));
    },
  } satisfies Parameters<typeof runCase>[2];
  await runCase(c, source, capturing);
  assert.deepEqual(seen, PROVIDER_OPTIONS);
});

/* --- Chat turns (#416) ------------------------------------------------------ */

function chatCase(expect: Record<string, unknown>) {
  return {
    name: "chat-x",
    mode: "chat" as const,
    catalog: "demo",
    prompt: "Requests by service?",
    expect,
  };
}

const drawPanel = (sql: string) => ({
  text: "",
  toolCalls: [
    {
      toolName: "showPanel",
      input: JSON.stringify({
        title: "Requests by service",
        viz: "table",
        query: { sourceId: source.id, sql },
      }),
    },
  ],
});

test("a chat case replays its steps through the engine and grades the drawn panel", async () => {
  const steps = [
    drawPanel("SELECT service, count(*) AS requests FROM http_requests GROUP BY service"),
    { text: "api is the busiest.", toolCalls: [] },
  ];
  const result = await runCase(
    chatCase({
      tables: ["http_requests"],
      minPanels: 1,
      maxPanels: 1,
      timeField: "absent",
    }),
    source,
    replayModel({ model: "m", recordedAt: "", requestDigest: "", text: "", steps }),
  );
  assert.deepEqual(result.failures, []);
  assert.equal(result.text, "api is the busiest.");
  assert.equal(result.steps?.length, 2);
});

test("a chat panel the guard refuses, or the wrong count, fails the case", async () => {
  const steps = [drawPanel("SELECT * FROM payroll"), { text: "Sorry.", toolCalls: [] }];
  const result = await runCase(
    chatCase({ minPanels: 1, runQuery: "required" }),
    source,
    replayModel({ model: "m", recordedAt: "", requestDigest: "", text: "", steps }),
  );
  assert.ok(result.failures.some((f) => /a panel was refused/.test(f)));
  assert.ok(result.failures.some((f) => /drew 0 panels; expected at least 1/.test(f)));
  assert.ok(result.failures.some((f) => /never fetched rows with runQuery/.test(f)));
});
