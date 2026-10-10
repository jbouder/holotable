import { test } from "node:test";
import assert from "node:assert/strict";
import type { UIMessage } from "ai";
import { chatSource, recordingExecutor, runTool } from "./support/chat";
import { sqlPlanOf } from "./support/plans";
import {
  type ChatPanelOutcome,
  type ChatQueryOutcome,
  type ChatScope,
  chatPanelSchema,
  showPanelTool,
  streamDataChat,
} from "@/lib/ai/data-chat";
import {
  MAX_SAMPLE_ROWS,
  modelOutputOf,
  nextPanelNumber,
  type ShowPanelOutput,
} from "@/lib/chat/panel";
import type { Model } from "@/lib/ai/provider";
import { STUB_CHAT_REPLY, stubModel } from "@/lib/ai/stub";
import { parseGroups } from "@/lib/auth/claims";
import { QueryExecutionError } from "@/lib/sources/execution";

const FROM = new Date("2026-07-11T11:00:00.000Z");
const TO = new Date("2026-07-11T12:00:00.000Z");

const source = chatSource("src-metrics");
const scope: ChatScope = {
  sources: [source],
  timeRange: { from: FROM.toISOString(), to: TO.toISOString() },
  identity: parseGroups("reader", ["/workspaces/ws-1/viewer"]),
};

const panel = {
  title: "Requests by service",
  description: "Count of HTTP requests in the range, grouped by service.",
  viz: "table" as const,
  query: {
    sourceId: "src-metrics",
    sql: "SELECT service, count(*) AS requests FROM http_requests GROUP BY service",
  },
};

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({ service: `svc-${i}`, requests: i }));
}

function tool(execute = recordingExecutor(rows(3)).execute) {
  const panels: ChatPanelOutcome[] = [];
  const queries: ChatQueryOutcome[] = [];
  let n = 1;
  const t = showPanelTool({
    scope,
    nextId: () => `p${n++}`,
    onPanel: (p) => panels.push(p),
    onQuery: (q) => queries.push(q),
    execute,
  });
  return { t, panels, queries };
}

test("showPanel runs an accepted spec once, under the server's window", async () => {
  const exec = recordingExecutor(rows(50));
  const { t, panels, queries } = tool(exec.execute);
  const out = await runTool<typeof panel, ShowPanelOutput>(t, panel);

  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.panelId, "p1");
  assert.equal(out.spec.id, "p1");
  assert.deepEqual(out.spec.layout, { x: 0, y: 0, w: 12, h: 4 });
  // The browser gets every row the source returned; the window is the server's.
  assert.equal(out.rows.length, 50);
  assert.equal(out.rowCount, 50);
  assert.deepEqual(out.window, { from: FROM.getTime(), to: TO.getTime() });

  assert.equal(exec.plans.length, 1);
  assert.match(sqlPlanOf(exec.plans[0]).sql, /\bLIMIT \d+$/);
  assert.deepEqual(
    panels.map((p) => p.outcome),
    ["accepted"],
  );
  assert.deepEqual(
    queries.map((q) => [q.outcome, q.panelId]),
    [["success", "p1"]],
  );
});

test("showPanel refuses a source outside the conversation without running it", async () => {
  const exec = recordingExecutor();
  const { t, panels } = tool(exec.execute);
  const out = await runTool<typeof panel, ShowPanelOutput>(t, {
    ...panel,
    query: { ...panel.query, sourceId: "src-elsewhere" },
  });
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /not available in this conversation/);
  assert.equal(exec.plans.length, 0);
  assert.deepEqual(
    panels.map((p) => [p.outcome, p.stage]),
    [["refused", "validate"]],
  );
});

test("showPanel hands back the guard's refusal and runs nothing", async () => {
  const exec = recordingExecutor();
  const { t, queries } = tool(exec.execute);
  for (const sql of [
    "SELECT * FROM payroll",
    "DELETE FROM http_requests",
    "SELECT count(*) FROM http_requests WHERE ts > now() - interval '1 hour'",
  ]) {
    const out = await runTool<typeof panel, ShowPanelOutput>(t, {
      ...panel,
      query: { ...panel.query, sql },
    });
    assert.equal(out.ok, false, sql);
  }
  assert.equal(exec.plans.length, 0);
  assert.ok(queries.every((q) => q.outcome === "failure" && q.stage === "validate"));
});

test("a statement that fails on the source is the tool's error, with its message", async () => {
  const { t, panels } = tool(async () => {
    throw new QueryExecutionError('column "nope" does not exist');
  });
  const out = await runTool<typeof panel, ShowPanelOutput>(t, panel);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(out.error, /column "nope"/);
  assert.equal(panels[0]?.stage, "execute");
});

test("the model is told the shape and a sample, never the result set", () => {
  const reduced = modelOutputOf({
    ok: true,
    panelId: "p1",
    spec: {},
    columns: ["service", "requests"],
    rows: rows(10_000),
    rowCount: 10_000,
    window: { from: 0, to: 1 },
  });
  assert.equal(reduced.ok, true);
  if (!reduced.ok) return;
  assert.equal(reduced.sample.length, MAX_SAMPLE_ROWS);
  assert.equal(reduced.rowCount, 10_000);
  assert.equal("rows" in reduced, false);
  assert.equal("spec" in reduced, false);
  // Reducing a reduced output changes nothing.
  assert.deepEqual(modelOutputOf(reduced), reduced);
});

test("the showPanel schema refuses what the server assigns or the kind forbids", async () => {
  const schema = chatPanelSchema([source]);
  assert.equal((await schema.safeParseAsync(panel)).success, true);
  for (const bad of [
    { ...panel, id: "mine" },
    { ...panel, layout: { x: 0, y: 0, w: 6, h: 4 } },
    { ...panel, timeRange: { from: "now-30d", to: "now" } },
    { ...panel, viz: "text" },
    { ...panel, viz: "state-timeline" },
    { title: "No query", viz: "table" },
  ]) {
    assert.equal((await schema.safeParseAsync(bad)).success, false, JSON.stringify(bad));
  }
});

test("panel ids continue after the conversation's earlier panels", () => {
  const earlier = [
    {
      id: "m1",
      role: "assistant",
      parts: [
        { type: "tool-showPanel", state: "output-available", output: { panelId: "p3" } },
        { type: "tool-showPanel", state: "output-available", output: { panelId: "p1" } },
        { type: "tool-runQuery", state: "output-available", output: { panelId: "p9" } },
      ],
    },
  ] as unknown as UIMessage[];
  assert.equal(nextPanelNumber(earlier), 4);
  assert.equal(nextPanelNumber([]), 1);
});

/* --- A whole turn ---------------------------------------------------------- */

type StubOptions = Parameters<ReturnType<typeof stubModel>["doStream"]>[0];

/** The stub, recording every prompt it is sent. */
function recordingStub() {
  const base = stubModel();
  const prompts: StubOptions[] = [];
  const model = {
    ...base,
    async doStream(options: StubOptions) {
      prompts.push(options);
      return base.doStream(options);
    },
  };
  return { model: model as unknown as Model, prompts };
}

const question: UIMessage[] = [
  { id: "u1", role: "user", parts: [{ type: "text", text: "Requests by service?" }] },
];

const SYSTEM = "sourceId: src-metrics\n";

test("a turn draws the recorded panel, then answers from its sample", async () => {
  const { model, prompts } = recordingStub();
  const exec = recordingExecutor(rows(40));
  const panels: ChatPanelOutcome[] = [];
  const result = await streamDataChat({
    system: SYSTEM,
    scope,
    model,
    messages: question,
    execute: exec.execute,
    onPanel: (p) => panels.push(p),
  });
  assert.equal(await result.text, STUB_CHAT_REPLY);
  assert.deepEqual(
    panels.map((p) => p.outcome),
    ["accepted"],
  );
  assert.equal(exec.plans.length, 1);

  // The second call carries the tool result as the model sees it.
  assert.equal(prompts.length, 2);
  const toolMessage = prompts[1].prompt.at(-1);
  assert.equal(toolMessage?.role, "tool");
  const sent = JSON.stringify(toolMessage);
  assert.match(sent, /"rowCount":40/);
  assert.match(sent, /svc-4/);
  assert.doesNotMatch(sent, /svc-5\b/);
});

test("an earlier panel's rows reach the model as its sample on the next turn", async () => {
  const { model, prompts } = recordingStub();
  const history = [
    ...question,
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-showPanel",
          toolCallId: "c1",
          state: "output-available",
          input: panel,
          output: {
            ok: true,
            panelId: "p1",
            spec: {},
            columns: ["service", "requests"],
            rows: rows(1_000),
            rowCount: 1_000,
            window: { from: 0, to: 1 },
          },
        },
        { type: "text", text: "Here it is." },
      ],
    },
    { id: "u2", role: "user", parts: [{ type: "text", text: "And now?" }] },
  ] as unknown as UIMessage[];
  const exec = recordingExecutor(rows(2));
  const result = await streamDataChat({
    system: SYSTEM,
    scope,
    model,
    messages: history,
    execute: exec.execute,
  });
  await result.text;
  const first = JSON.stringify(prompts[0].prompt);
  assert.match(first, /"rowCount":1000/);
  assert.doesNotMatch(first, /svc-999/);
  // The new panel is numbered after the old one.
  const steps = await result.steps;
  const [call] = steps.flatMap((s) => s.toolResults);
  assert.ok(call);
  assert.equal((call.output as { panelId?: string }).panelId, "p2");
});

test("the dashboard chat's turn is offered runQuery alone", async () => {
  const { model, prompts } = recordingStub();
  const result = await streamDataChat({
    system: SYSTEM,
    scope,
    draw: false,
    model,
    messages: question,
    execute: recordingExecutor().execute,
  });
  assert.equal(await result.text, STUB_CHAT_REPLY);
  assert.deepEqual(
    prompts[0].tools?.map((t) => t.name),
    ["runQuery"],
  );
});

/* --- The one repair -------------------------------------------------------- */

/** A model that writes `first` as its showPanel call, and `repairs` when asked again. */
function scriptedModel(first: unknown, repairs: unknown[]) {
  const base = stubModel();
  let streams = 0;
  let generates = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = {
    ...base,
    async doStream(options: StubOptions) {
      streams += 1;
      if (options.prompt.at(-1)?.role === "tool") return base.doStream(options);
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: "stream-start", warnings: [] });
            controller.enqueue({
              type: "tool-call",
              toolCallId: "c1",
              toolName: "showPanel",
              input: JSON.stringify(first),
            });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool_calls" },
              usage,
            });
            controller.close();
          },
        }),
      };
    },
    async doGenerate() {
      const input = repairs[generates++];
      return {
        content: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "showPanel",
            input: JSON.stringify(input),
          },
        ],
        finishReason: { unified: "tool-calls", raw: "tool_calls" },
        usage,
        warnings: [],
      };
    },
  };
  return {
    model: model as unknown as Model,
    calls: () => ({ streams, generates }),
  };
}

test("a spec that fails its schema is repaired once, and the repair is drawn", async () => {
  const { model, calls } = scriptedModel({ ...panel, viz: "text" }, [panel]);
  const exec = recordingExecutor(rows(2));
  const repairs: boolean[] = [];
  const panels: ChatPanelOutcome[] = [];
  const result = await streamDataChat({
    system: SYSTEM,
    scope,
    model,
    messages: question,
    execute: exec.execute,
    onRepair: (r) => repairs.push(r.repaired),
    onPanel: (p) => panels.push(p),
  });
  assert.equal(await result.text, STUB_CHAT_REPLY);
  assert.deepEqual(repairs, [true]);
  assert.deepEqual(
    panels.map((p) => p.outcome),
    ["accepted"],
  );
  assert.equal(exec.plans.length, 1);
  assert.equal(calls().generates, 1);
});

test("a repair that fails again is the tool's error, and nothing runs", async () => {
  const bad = { ...panel, viz: "text" };
  const { model, calls } = scriptedModel(bad, [bad, bad]);
  const exec = recordingExecutor(rows(2));
  const repairs: boolean[] = [];
  const result = await streamDataChat({
    system: SYSTEM,
    scope,
    model,
    messages: question,
    execute: exec.execute,
    onRepair: (r) => repairs.push(r.repaired),
  });
  await result.text;
  assert.deepEqual(repairs, [false]);
  assert.equal(exec.plans.length, 0);
  // One repair per turn, however many times the model tries.
  assert.equal(calls().generates, 1);
});
