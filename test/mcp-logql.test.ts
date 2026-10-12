import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

/*
 * The MCP tools against a Loki source (#566), end to end: the real Loki
 * kind's guard, plan and client against a fake Loki on a loopback port.
 * `./support/loki-env` sets what the client reads before `config` loads,
 * so it is imported first.
 */
import "./support/loki-env";
import { parseGroups } from "@/lib/auth/claims";
import type { DashboardRecord } from "@/lib/dashboard-metadata";
import { SPEC_VERSION } from "@/lib/ir";
import { callTool, type McpTool } from "@/lib/mcp/tool";
import { type McpDeps, MCP_INSTRUCTIONS, mcpTools } from "@/lib/mcp/tools";
import { SourceConfig, type SourceRecord } from "@/lib/registry";
import { serverKind } from "@/lib/sources/server/registry";
import { type FakeLoki, getOnly, lokiSuccess, startFakeLoki } from "./support/fake-loki";

let fake: FakeLoki;
let logs: SourceRecord;
const created: unknown[] = [];

before(async () => {
  fake = await startFakeLoki();
  logs = {
    id: "src-logs",
    workspaceId: "ws",
    name: "Logs",
    kind: "loki",
    config: SourceConfig.parse({
      kind: "loki",
      url: fake.url,
      auth: "bearer",
      labels: [
        { name: "app", values: ["api", "web"] },
        { name: "level", values: ["error", "info"] },
      ],
    }),
    secretRef: "LOKI_TEST",
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tombstonedAt: null,
  };
});

after(async () => {
  await fake.close();
});

beforeEach(() => {
  fake.seen.length = 0;
  created.length = 0;
});

/** Only what the source and dashboard tools reach; the rest is never called. */
function deps(): McpDeps {
  return {
    getSource: async (id: string) => (id === logs.id ? logs : null),
    listSources: async (workspaceId: string) =>
      workspaceId === logs.workspaceId ? [logs] : [],
    // The production wiring: the source's own kind runs the plan.
    executePlan: (source, plan) => serverKind(source).execute(source, plan),
    createDashboard: async (input) => {
      created.push(input);
      return {
        id: "22222222-2222-4222-8222-222222222222",
        workspaceId: input.workspaceId,
        version: 1,
      } as DashboardRecord;
    },
  } as Partial<McpDeps> as McpDeps;
}

const editor = parseGroups("alice", ["/workspaces/ws/editor"]);

async function call(
  tools: McpTool[],
  name: string,
  args: unknown,
): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, name);
  const result = await callTool(found, args, { identity: editor });
  return {
    ok: result.isError !== true,
    text: result.content[0]?.text ?? "",
    data: result.structuredContent ?? {},
  };
}

test("the instructions name LogQL for a Loki source", () => {
  assert.match(MCP_INSTRUCTIONS, /logql for kind loki/);
});

test("list_sources and describe_source show a Loki source's labels, never its URL or credential", async () => {
  const tools = mcpTools(deps());
  const listed = await call(tools, "list_sources", {});
  assert.ok(listed.ok, listed.text);
  assert.deepEqual(listed.data.sources, [
    {
      id: "src-logs",
      workspaceId: "ws",
      name: "Logs",
      kind: "loki",
      language: "logql",
      labelCount: 2,
      catalog: "ok",
    },
  ]);
  const described = await call(tools, "describe_source", { sourceId: "src-logs" });
  assert.ok(described.ok, described.text);
  assert.equal(described.data.language, "logql");
  assert.deepEqual(described.data.labels, [
    { name: "app", values: ["api", "web"] },
    { name: "level", values: ["error", "info"] },
  ]);
  for (const text of [listed.text, described.text]) {
    assert.doesNotMatch(text, /127\.0\.0\.1|LOKI_TEST|l0ki|bearer|url|canManage/);
  }
});

test("validate_sql takes LogQL for a Loki source: the guard's verdict, by its own words", async () => {
  const tools = mcpTools(deps());
  const ok = await call(tools, "validate_sql", {
    sourceId: "src-logs",
    logql: '{app="api"} |= ":needle"',
    variables: ["needle"],
  });
  assert.deepEqual(ok.data, { ok: true });
  const unanchored = await call(tools, "validate_sql", {
    sourceId: "src-logs",
    logql: '{app=~".+"}',
  });
  assert.equal(unanchored.data.ok, false);
  assert.match(String(unanchored.data.error), /needs an "=" matcher/);
  const instantLog = await call(tools, "validate_sql", {
    sourceId: "src-logs",
    logql: '{app="api"}',
    instant: true,
  });
  assert.match(String(instantLog.data.error), /cannot be an instant query/);
  const wrong = await call(tools, "validate_sql", {
    sourceId: "src-logs",
    promql: "up",
  });
  assert.match(String(wrong.data.error), /answers LogQL; this query is PromQL/);
  const timeField = await call(tools, "run_query", {
    sourceId: "src-logs",
    logql: '{app="api"}',
    timeField: "ts",
  });
  assert.equal(timeField.ok, false);
  assert.match(timeField.text, /timeField is for sql only/);
  // Nothing reached Loki: the guard answers on its own.
  assert.equal(fake.seen.length, 0);
});

test("run_query runs a log query and a metric query through the plan the server builds", async () => {
  fake.handle = getOnly((request) =>
    request.query.has("step")
      ? lokiSuccess({
          resultType: "matrix",
          result: [{ metric: { app: "api" }, values: [[1_760_000_000, "3"]] }],
        })
      : lokiSuccess({
          resultType: "streams",
          result: [
            {
              stream: { app: "api", level: "error" },
              values: [["1760000000000000000", "boom"]],
            },
          ],
        }),
  );
  const tools = mcpTools(deps());
  const lines = await call(tools, "run_query", {
    sourceId: "src-logs",
    logql: '{app="api"} |= "boom"',
    timeRange: { from: "now-1h", to: "now" },
  });
  assert.ok(lines.ok, lines.text);
  assert.deepEqual(lines.data.columns, ["time", "message", "app", "level"]);
  assert.equal((lines.data.rows as { message: string }[])[0].message, "boom");
  const [request] = fake.seen;
  assert.equal(request.path, "/loki/api/v1/query_range");
  // The server's start, end, limit and direction, and the author's query only.
  assert.deepEqual([...request.query.keys()].sort(), [
    "direction",
    "end",
    "limit",
    "query",
    "start",
  ]);
  assert.equal(request.query.get("query"), '{app="api"} |= "boom"');
  // The credential is resolved on the server, under the workspace's grant.
  assert.equal(request.headers.authorization, "Bearer l0ki-t0ken-secret");

  fake.seen.length = 0;
  const series = await call(tools, "run_query", {
    sourceId: "src-logs",
    logql: 'sum by (app) (count_over_time({app="api"}[5m]))',
    minStep: "1m",
  });
  assert.ok(series.ok, series.text);
  assert.equal(series.data.rowCount, 1);
  assert.deepEqual([...fake.seen[0].query.keys()].sort(), [
    "end",
    "query",
    "start",
    "step",
  ]);

  // A refusal never reaches Loki.
  fake.seen.length = 0;
  const refused = await call(tools, "run_query", {
    sourceId: "src-logs",
    logql: '{app="api"} offset 30d',
  });
  assert.equal(refused.ok, false);
  assert.equal(fake.seen.length, 0);
});

test("save_dashboard keeps a logs panel on a Loki source, checked by the LogQL guard", async () => {
  const tools = mcpTools(deps());
  const spec = (logql: string) => ({
    specVersion: SPEC_VERSION,
    title: "API logs",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [
      {
        id: "errors",
        title: "API errors",
        viz: "logs",
        query: { sourceId: "src-logs", logql },
        options: { limit: 200, level: "level" },
        layout: { x: 0, y: 0, w: 12, h: 6 },
      },
    ],
  });
  const saved = await call(tools, "save_dashboard", {
    spec: spec('{app="api", level="error"}'),
  });
  assert.ok(saved.ok, saved.text);
  assert.equal(created.length, 1);
  const refused = await call(tools, "save_dashboard", { spec: spec("{}") });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /errors/);
  assert.equal(created.length, 1);
});
