import assert from "node:assert/strict";
import { sqlPlanOf } from "./support/plans";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import type { GenerationFinish, OnGenerationFinish } from "@/lib/ai/generate";
import type { Model } from "@/lib/ai/provider";
import type { Failure } from "@/lib/ai/repair";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import type { DashboardRecord } from "@/lib/dashboard-metadata";
import { type Dashboard, SPEC_VERSION } from "@/lib/ir";
import { callTool, type McpTool } from "@/lib/mcp/tool";
import { type McpDeps, MCP_INSTRUCTIONS, mcpTools } from "@/lib/mcp/tools";
import { MAX_TOOL_ROWS } from "@/lib/mcp/tools/sql";
import {
  type SourceRecord,
  type SqlSourceConfig,
  type SqlSourceRecord,
  TimescaleDbConfig,
} from "@/lib/registry";
import { PrometheusConfig } from "@/lib/sources/kinds/prometheus";
import type { PromqlPlan } from "@/lib/promql/plan";
import type { ExecutablePlan } from "@/lib/sql/safety";

/**
 * The MCP tools (#148) over fakes for the database, the sources and the
 * model: each one authorizes the caller as its HTTP route does, validates
 * what it is given through the same code, and never hands out a connection
 * detail, a credential or unguarded data.
 */

function makeSource(
  id: string,
  workspaceId = "ws-1",
  overrides: Partial<SqlSourceRecord> = {},
): SqlSourceRecord {
  return {
    id,
    workspaceId,
    name: `Source ${id}`,
    kind: "timescaledb",
    config: TimescaleDbConfig.parse({
      host: "db.internal",
      port: 5432,
      database: "metrics",
      schema: "metrics",
      ssl: false,
      tables: [
        {
          name: "http_requests",
          timeField: "ts",
          columns: [
            { name: "ts", type: "timestamp with time zone" },
            { name: "service", type: "text" },
            { name: "value", type: "double precision" },
          ],
        },
      ],
    }),
    secretRef: "TS_SECRET_REF",
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "user-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tombstonedAt: null,
    ...overrides,
  };
}

const app = makeSource("src-app");
/** A Prometheus source in the same workspace (#389). */
const prom = {
  id: "src-prom",
  workspaceId: "ws-1",
  name: "Prom",
  kind: "prometheus",
  config: PrometheusConfig.parse({
    kind: "prometheus",
    url: "https://prometheus.internal:9090",
    auth: "bearer",
    metrics: [
      { name: "up", type: "gauge", labels: ["instance", "job"] },
      {
        name: "http_requests_total",
        type: "counter",
        help: "Requests served.",
        labels: ["code", "instance", "job"],
      },
    ],
  }),
  secretRef: "PROM_TOKEN",
  catalogRefreshedAt: new Date().toISOString(),
  catalogMissingTables: [],
  createdBy: "user-1",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  tombstonedAt: null,
} as unknown as SourceRecord;
const other = makeSource("src-other", "ws-2");
const removed = makeSource("src-gone", "ws-1", {
  tombstonedAt: "2026-02-01T00:00:00.000Z",
});

const DASH = "22222222-2222-4222-8222-222222222222";
const OTHER_DASH = "33333333-3333-4333-8333-333333333333";

function spec(sourceId = "src-app", extra: Record<string, unknown> = {}): Dashboard {
  return {
    specVersion: SPEC_VERSION,
    title: "Requests",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [
      {
        id: "requests",
        title: "Requests",
        viz: "table",
        query: { sourceId, sql: "SELECT ts, value FROM http_requests" },
        layout: { x: 0, y: 0, w: 12, h: 4 },
      },
    ],
    ...extra,
  } as Dashboard;
}

const record: DashboardRecord = {
  id: DASH,
  workspaceId: "ws-1",
  title: "Requests",
  description: null,
  tags: ["ops"],
  createdBy: "user-1",
  version: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  favorite: false,
  spec: spec(),
};

const usage = {
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
} as LanguageModelUsage;

/** A finished `streamObject` as far as the tools read one. */
function stream(
  onFinish: OnGenerationFinish | undefined,
  outcome: { object: unknown } | { failure: Failure | null; error: Error },
) {
  const event: GenerationFinish = {
    object: "object" in outcome ? outcome.object : undefined,
    usage,
    error: "object" in outcome ? undefined : outcome.error,
    modelId: "test-model",
    failure: "object" in outcome ? null : outcome.failure,
  };
  onFinish?.(event);
  return {
    fullStream: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    object:
      "object" in outcome
        ? Promise.resolve(outcome.object)
        : Promise.reject(outcome.error),
  };
}

interface Calls {
  executed: ExecutablePlan[];
  /** PromQL plans the executor got (#389). */
  promql: PromqlPlan[];
  created: unknown[];
  saved: unknown[];
  invalidated: string[];
  admitted: string[];
  recorded: LanguageModelUsage[];
  generations: unknown[];
  starts: { repair: boolean }[];
}

function fakeDeps(
  overrides: Partial<McpDeps> = {},
  generation: Array<Parameters<typeof stream>[1]> = [{ object: null }],
): { deps: McpDeps; calls: Calls } {
  const calls: Calls = {
    executed: [],
    promql: [],
    created: [],
    saved: [],
    invalidated: [],
    admitted: [],
    recorded: [],
    generations: [],
    starts: [],
  };
  const sources: SourceRecord[] = [app, prom, other, removed];
  const rows = Array.from({ length: MAX_TOOL_ROWS + 50 }, (_, i) => ({
    ts: `2026-01-01T00:${String(i % 60).padStart(2, "0")}:00Z`,
    value: i,
  }));
  const next = () => {
    const outcome = generation.shift();
    assert.ok(outcome, "more model calls than the test expected");
    return outcome;
  };
  const deps: McpDeps = {
    getSource: async (id) => sources.find((s) => s.id === id) ?? null,
    listSources: async (workspaceId) =>
      sources.filter((s) => s.workspaceId === workspaceId && !s.tombstonedAt),
    executePlan: async (_source, plan) => {
      if (plan.language === "promql") {
        calls.promql.push(plan.plan);
        return {
          columns: ["time", '{job="api"}'],
          rows: [{ time: "2026-01-01T00:00:00Z", '{job="api"}': 1.5 }],
        };
      }
      calls.executed.push(sqlPlanOf(plan));
      return { columns: ["ts", "value"], rows };
    },
    listDashboards: async (workspaceId) =>
      workspaceId === "ws-1"
        ? { dashboards: [record], total: 1 }
        : { dashboards: [], total: 0 },
    getDashboard: async (id) => (id === DASH ? record : null),
    createDashboard: async (input) => {
      calls.created.push(input);
      return { ...record, id: OTHER_DASH, version: 1, workspaceId: input.workspaceId };
    },
    saveDashboardVersion: async (input) => {
      calls.saved.push(input);
      return { ...record, version: record.version + 1 };
    },
    invalidatePoller: (id) => {
      calls.invalidated.push(id);
    },
    enforceLlmLimits: async ({ route }) => {
      calls.admitted.push(route);
      return {
        record(u: LanguageModelUsage) {
          calls.recorded.push(u);
        },
      } as Awaited<ReturnType<McpDeps["enforceLlmLimits"]>>;
    },
    requireModel: async () => ({
      ok: true,
      source: "workspace",
      modelId: "ws-model",
      model: {} as Model,
    }),
    workspacePromptFor: async () => null,
    listLinkableDashboards: async () => [],
    streamDashboard: ((input: { onFinish?: OnGenerationFinish; repair?: Failure }) => {
      calls.starts.push({ repair: input.repair !== undefined });
      return stream(input.onFinish, next());
    }) as unknown as McpDeps["streamDashboard"],
    streamExplorePanel: ((input: { onFinish?: OnGenerationFinish; repair?: Failure }) => {
      calls.starts.push({ repair: input.repair !== undefined });
      return stream(input.onFinish, next());
    }) as unknown as McpDeps["streamExplorePanel"],
    streamSourceDraft: ((input: { onFinish?: OnGenerationFinish; repair?: Failure }) => {
      calls.starts.push({ repair: input.repair !== undefined });
      return stream(input.onFinish, next());
    }) as unknown as McpDeps["streamSourceDraft"],
    secretRefGrants: () => new Map(),
    recordGeneration: (event) => {
      calls.generations.push(event);
    },
    ...overrides,
  };
  return { deps, calls };
}

const editor = parseGroups("alice", ["/workspaces/ws-1/editor"]);
const viewer = parseGroups("vic", ["/workspaces/ws-1/viewer"]);
const admin = parseGroups("ada", ["/workspaces/ws-1/source-admin"]);
const outsider = parseGroups("otto", ["/workspaces/ws-2/editor"]);

function tool(tools: McpTool[], name: string): McpTool {
  const found = tools.find((t) => t.name === name);
  assert.ok(found, name);
  return found;
}

async function call(
  tools: McpTool[],
  name: string,
  args: unknown,
  identity = editor,
): Promise<{ ok: boolean; text: string; data: Record<string, unknown> }> {
  const result = await callTool(tool(tools, name), args, { identity });
  return {
    ok: result.isError !== true,
    text: result.content[0]?.text ?? "",
    data: result.structuredContent ?? {},
  };
}

test("the tools are the ones the issue names, each annotated, and the instructions say the workflow", () => {
  const tools = mcpTools(fakeDeps().deps);
  assert.deepEqual(
    tools.map((t) => t.name),
    [
      "list_sources",
      "describe_source",
      "validate_sql",
      "run_query",
      "list_dashboards",
      "get_dashboard",
      "save_dashboard",
      "generate_dashboard",
      "generate_panel",
      "generate_source",
    ],
  );
  for (const t of tools) {
    assert.ok(t.title && t.description, t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
  }
  assert.equal(tool(tools, "run_query").annotations.readOnlyHint, true);
  assert.equal(tool(tools, "save_dashboard").annotations.readOnlyHint, false);
  assert.equal(tool(tools, "generate_dashboard").annotations.openWorldHint, true);
  assert.match(
    MCP_INSTRUCTIONS,
    /list_sources[\s\S]*describe_source[\s\S]*validate_sql[\s\S]*run_query[\s\S]*save_dashboard/,
  );
  assert.match(MCP_INSTRUCTIONS, /Never add a time filter/);
});

/* -------------------------------------------------------------------------- */
/* Sources                                                                    */
/* -------------------------------------------------------------------------- */

test("list_sources shows the caller's workspaces, and never a connection detail", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const mine = await call(tools, "list_sources", {}, viewer);
  assert.ok(mine.ok);
  assert.deepEqual(mine.data, {
    sources: [
      {
        id: "src-app",
        workspaceId: "ws-1",
        name: "Source src-app",
        kind: "timescaledb",
        language: "sql",
        schema: "metrics",
        tableCount: 1,
        catalog: "ok",
      },
      {
        id: "src-prom",
        workspaceId: "ws-1",
        name: "Prom",
        kind: "prometheus",
        language: "promql",
        metricCount: 2,
        catalog: "ok",
      },
    ],
  });
  assert.doesNotMatch(
    mine.text,
    /db\.internal|TS_SECRET_REF|5432|prometheus\.internal|PROM_TOKEN|bearer/,
  );

  const none = await call(tools, "list_sources", {}, parseGroups("nobody", []));
  assert.deepEqual(none.data, { sources: [] });

  const denied = await call(tools, "list_sources", { workspaceId: "ws-2" }, viewer);
  assert.equal(denied.ok, false);
  assert.match(denied.text, /not authorized for source:use/);
});

test("describe_source is the catalog and nothing else", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const described = await call(tools, "describe_source", { sourceId: "src-app" }, viewer);
  assert.ok(described.ok, described.text);
  assert.equal(described.data.id, "src-app");
  assert.equal(described.data.schema, "metrics");
  const tables = described.data.tables as { name: string; columns: { name: string }[] }[];
  assert.deepEqual(
    tables.map((t) => [t.name, t.columns.map((c) => c.name)]),
    [["http_requests", ["ts", "service", "value"]]],
  );
  assert.doesNotMatch(
    described.text,
    /db\.internal|TS_SECRET_REF|secretRef|host|canManage/,
  );

  assert.equal(
    (await call(tools, "describe_source", { sourceId: "src-app" }, outsider)).ok,
    false,
  );
  const gone = await call(tools, "describe_source", { sourceId: "src-gone" });
  assert.equal(gone.ok, false);
  assert.equal(gone.text, "unknown or removed source");
  assert.equal((await call(tools, "describe_source", { sourceId: "nope" })).ok, false);
});

/* -------------------------------------------------------------------------- */
/* SQL                                                                        */
/* -------------------------------------------------------------------------- */

test("validate_sql is the guard's verdict, for editors", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const ok = await call(tools, "validate_sql", {
    sourceId: "src-app",
    sql: "SELECT ts, value FROM http_requests",
  });
  assert.deepEqual(ok.data, { ok: true });

  const bad = await call(tools, "validate_sql", {
    sourceId: "src-app",
    sql: "SELECT ts FROM secrets",
  });
  assert.ok(bad.ok, "a rejection is a result, not a failure");
  assert.equal(bad.data.ok, false);
  assert.match(String(bad.data.error), /secrets/);

  const viewed = await call(
    tools,
    "validate_sql",
    { sourceId: "src-app", sql: "SELECT 1" },
    viewer,
  );
  assert.equal(viewed.ok, false);
  assert.match(viewed.text, /not authorized for dashboard:generate/);
});

test("run_query goes through the guard, the plan and the executor, capped for the model", async () => {
  const { deps, calls } = fakeDeps();
  const tools = mcpTools(deps);
  const ran = await call(tools, "run_query", {
    sourceId: "src-app",
    sql: "SELECT ts, value FROM http_requests",
    timeField: "ts",
    timeRange: { from: "now-6h", to: "now" },
  });
  assert.ok(ran.ok, ran.text);
  assert.deepEqual(ran.data.columns, ["ts", "value"]);
  assert.equal((ran.data.rows as unknown[]).length, MAX_TOOL_ROWS);
  assert.equal(ran.data.rowCount, MAX_TOOL_ROWS + 50);
  assert.equal(ran.data.truncated, true);
  const window = ran.data.window as { from: string; to: string };
  assert.ok(Date.parse(window.to) - Date.parse(window.from) === 6 * 3600 * 1000);
  // The plan the executor got is the guarded, windowed one, not the raw text.
  assert.equal(calls.executed.length, 1);
  assert.match(calls.executed[0].sql, /^SELECT \* FROM \(/);
  assert.equal(calls.executed[0].params.length >= 2, true);

  // Refused by the guard: the executor is never reached.
  const refused = await call(tools, "run_query", {
    sourceId: "src-app",
    sql: "SELECT ts FROM secrets",
  });
  assert.equal(refused.ok, false);
  assert.match(refused.text, /secrets/);
  assert.equal(calls.executed.length, 1);

  // A bad window is the caller's, said plainly.
  const backwards = await call(tools, "run_query", {
    sourceId: "src-app",
    sql: "SELECT ts, value FROM http_requests",
    timeRange: { from: "now", to: "now-1h" },
  });
  assert.equal(backwards.ok, false);
  assert.equal(calls.executed.length, 1);

  // The server's default window when none is given.
  const defaulted = await call(tools, "run_query", {
    sourceId: "src-app",
    sql: "SELECT ts, value FROM http_requests",
  });
  assert.ok(defaulted.ok);
  assert.equal(
    (await call(tools, "run_query", { sourceId: "src-app", sql: "SELECT 1" }, viewer)).ok,
    false,
  );
});

/* -------------------------------------------------------------------------- */
/* Dashboards                                                                 */
/* -------------------------------------------------------------------------- */

test("list_dashboards and get_dashboard are scoped by the claims", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const listed = await call(tools, "list_dashboards", {}, viewer);
  assert.ok(listed.ok, listed.text);
  assert.deepEqual(listed.data, {
    dashboards: [
      {
        id: DASH,
        workspaceId: "ws-1",
        title: "Requests",
        description: null,
        tags: ["ops"],
        version: 3,
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    ],
    total: 1,
  });
  assert.deepEqual((await call(tools, "list_dashboards", {}, outsider)).data, {
    dashboards: [],
    total: 0,
  });

  const got = await call(tools, "get_dashboard", { dashboardId: DASH }, viewer);
  assert.ok(got.ok);
  assert.equal((got.data.dashboard as DashboardRecord).spec.panels[0].id, "requests");
  assert.equal(
    (await call(tools, "get_dashboard", { dashboardId: DASH }, outsider)).ok,
    false,
  );
  assert.equal(
    (await call(tools, "get_dashboard", { dashboardId: OTHER_DASH })).ok,
    false,
  );
  assert.equal(
    (await call(tools, "get_dashboard", { dashboardId: "not-a-uuid" })).ok,
    false,
  );
});

test("save_dashboard derives the workspace from the sources and validates every panel", async () => {
  const { deps, calls } = fakeDeps();
  const tools = mcpTools(deps);

  const created = await call(tools, "save_dashboard", { spec: spec() });
  assert.ok(created.ok, created.text);
  assert.equal(created.data.id, OTHER_DASH);
  assert.equal(created.data.workspaceId, "ws-1");
  assert.equal(calls.created.length, 1);

  // A stored spec of an earlier shape is upgraded, as the routes upgrade one.
  const { specVersion: _, ...older } = spec();
  const upgraded = await call(tools, "save_dashboard", { spec: older });
  assert.ok(upgraded.ok, upgraded.text);
  assert.equal((calls.created[1] as { spec: Dashboard }).spec.specVersion, SPEC_VERSION);

  const versioned = await call(tools, "save_dashboard", {
    spec: spec(),
    dashboardId: DASH,
    note: " second ",
  });
  assert.ok(versioned.ok, versioned.text);
  assert.equal(versioned.data.version, 4);
  assert.deepEqual(calls.invalidated, [DASH]);
  assert.equal((calls.saved[0] as { note: string | null }).note, "second");

  // A panel the guard refuses names itself; nothing is written.
  const rejected = await call(tools, "save_dashboard", {
    spec: spec("src-app", {
      panels: [
        {
          ...spec().panels[0],
          query: { sourceId: "src-app", sql: "SELECT ts FROM secrets" },
        },
      ],
    }),
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.text, /^panel "requests": /);

  // The workspace comes from the trusted source record, never an argument.
  const foreign = await call(tools, "save_dashboard", { spec: spec("src-other") });
  assert.equal(foreign.ok, false);
  assert.match(foreign.text, /not authorized for dashboard:create/);
  const moved = await call(
    tools,
    "save_dashboard",
    { spec: spec("src-other"), dashboardId: DASH },
    outsider,
  );
  assert.equal(moved.ok, false);
  assert.match(moved.text, /different workspace/);

  assert.equal((await call(tools, "save_dashboard", { spec: spec() }, viewer)).ok, false);
  assert.equal(calls.created.length, 2);
  assert.equal(calls.saved.length, 1);
});

/* -------------------------------------------------------------------------- */
/* Generation                                                                 */
/* -------------------------------------------------------------------------- */

const generated = {
  title: "Requests",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 30_000,
  panels: [spec().panels[0]],
};

test("generate_dashboard is admitted, recorded and audited like the route, and returns a stamped spec", async () => {
  const { deps, calls } = fakeDeps({}, [{ object: generated }]);
  const tools = mcpTools(deps);
  const result = await call(tools, "generate_dashboard", {
    sourceId: "src-app",
    prompt: "requests over time",
  });
  assert.ok(result.ok, result.text);
  const out = result.data.spec as Dashboard;
  assert.equal(out.specVersion, SPEC_VERSION);
  assert.equal(out.panels[0].id, "requests");
  assert.deepEqual(calls.admitted, ["generate"]);
  assert.deepEqual(calls.recorded, [usage]);
  assert.equal(calls.generations.length, 1);
  assert.equal((calls.generations[0] as { mode: string }).mode, "dashboard");
  // Which level's model answered is recorded, as on the HTTP routes (#331).
  assert.equal(
    (calls.generations[0] as { modelConfig: string }).modelConfig,
    "workspace",
  );
  assert.deepEqual(calls.starts, [{ repair: false }]);

  assert.equal(
    (
      await call(
        tools,
        "generate_dashboard",
        { sourceId: "src-app", prompt: "x" },
        viewer,
      )
    ).ok,
    false,
  );
});

test("a rate limit or budget refusal is the tool's answer, before any model call", async () => {
  const { deps, calls } = fakeDeps({
    enforceLlmLimits: async () => {
      throw new HttpError(429, "rate limit reached: 20 model requests per minute", {
        "Retry-After": "30",
      });
    },
  });
  const tools = mcpTools(deps);
  const limited = await call(tools, "generate_panel", {
    sourceId: "src-app",
    prompt: "x",
  });
  assert.equal(limited.ok, false);
  assert.match(limited.text, /^rate limit reached/);
  assert.deepEqual(calls.starts, []);
});

test("a model that cannot be called is the tool's answer, before anything is admitted (#331)", async () => {
  const { deps, calls } = fakeDeps({
    requireModel: async () => {
      throw new HttpError(503, "This workspace's model key can no longer be read");
    },
  });
  const result = await call(mcpTools(deps), "generate_panel", {
    sourceId: "src-app",
    prompt: "x",
  });
  assert.equal(result.ok, false);
  assert.match(result.text, /can no longer be read/);
  assert.deepEqual(calls.admitted, []);
  assert.deepEqual(calls.starts, []);
});

test("an answer that fails the schema is repaired once, as a second admitted call", async () => {
  const failure: Failure = { text: "{}", issues: ["panels: required"] };
  const { deps, calls } = fakeDeps({}, [
    { failure, error: new Error("No object generated") },
    { object: spec().panels[0] },
  ]);
  const tools = mcpTools(deps);
  const result = await call(tools, "generate_panel", {
    sourceId: "src-app",
    prompt: "requests",
  });
  assert.ok(result.ok, result.text);
  assert.equal((result.data.panel as { id: string }).id, "requests");
  assert.deepEqual(calls.starts, [{ repair: false }, { repair: true }]);
  assert.deepEqual(calls.admitted, ["generate", "generate"]);
  assert.equal(calls.generations.length, 2);

  // And only once: a second failure is the answer.
  const twice = fakeDeps({}, [
    { failure, error: new Error("No object generated") },
    { failure, error: new Error("No object generated") },
  ]);
  const again = await call(mcpTools(twice.deps), "generate_panel", {
    sourceId: "src-app",
    prompt: "requests",
  });
  assert.equal(again.ok, false);
  assert.match(again.text, /did not match the schema: panels: required/);
  assert.equal(twice.calls.starts.length, 2);

  // A failure with nothing to repair (the provider's) is not retried.
  const refused = fakeDeps({}, [{ failure: null, error: new Error("boom") }]);
  const once = await call(mcpTools(refused.deps), "generate_panel", {
    sourceId: "src-app",
    prompt: "requests",
  });
  assert.equal(once.ok, false);
  assert.equal(refused.calls.starts.length, 1);
});

test("generate_source needs source-admin and drafts under the source-draft limits", async () => {
  const draft = {
    id: "metrics",
    name: "Metrics",
    secretRef: "TS_METRICS",
    config: {
      host: "db.internal",
      port: 5432,
      database: "metrics",
      schema: "metrics",
      ssl: false,
      tables: [
        {
          name: "http_requests",
          timeField: "ts",
          columns: [{ name: "ts", type: "timestamp with time zone" }],
        },
      ],
    },
  };
  const { deps, calls } = fakeDeps({}, [{ object: draft }]);
  const tools = mcpTools(deps);
  assert.equal(
    (await call(tools, "generate_source", { workspaceId: "ws-1", prompt: "x" })).ok,
    false,
  );
  const drafted = await call(
    tools,
    "generate_source",
    { workspaceId: "ws-1", prompt: "x" },
    admin,
  );
  assert.ok(drafted.ok, drafted.text);
  assert.equal((drafted.data.draft as { secretRef: string }).secretRef, "TS_METRICS");
  assert.deepEqual(calls.admitted, ["source-draft"]);
  assert.equal((calls.generations[0] as { mode: string }).mode, "source-draft");
});

test("generate_dashboard tells the model which dashboards a link may lead to (#375)", async () => {
  const seen: { dashboards?: unknown }[] = [];
  const asked: string[] = [];
  const base = fakeDeps({}, [{ object: generated }]);
  const deps: McpDeps = {
    ...base.deps,
    listLinkableDashboards: async (workspaceId) => {
      asked.push(workspaceId);
      return [{ id: DASH, title: "Host detail", variables: ["host"] }];
    },
    streamDashboard: ((input: Parameters<McpDeps["streamDashboard"]>[0]) => {
      seen.push({ dashboards: input.dashboards });
      return base.deps.streamDashboard(input);
    }) as McpDeps["streamDashboard"],
  };
  const result = await call(mcpTools(deps), "generate_dashboard", {
    sourceId: "src-app",
    prompt: "fleet overview",
  });
  assert.ok(result.ok, result.text);
  assert.deepEqual(asked, ["ws-1"]);
  assert.deepEqual(seen, [
    { dashboards: [{ id: DASH, title: "Host detail", variables: ["host"] }] },
  ]);
});

/* -------------------------------------------------------------------------- */
/* PromQL (#389)                                                              */
/* -------------------------------------------------------------------------- */

test("describe_source on a Prometheus source is its metrics and labels, never its URL or auth", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const described = await call(
    tools,
    "describe_source",
    { sourceId: "src-prom" },
    viewer,
  );
  assert.ok(described.ok, described.text);
  assert.equal(described.data.kind, "prometheus");
  assert.equal(described.data.language, "promql");
  const metrics = described.data.metrics as {
    name: string;
    type: string;
    labels: string[];
  }[];
  assert.deepEqual(
    metrics.map((m) => [m.name, m.type, m.labels]),
    [
      ["up", "gauge", ["instance", "job"]],
      ["http_requests_total", "counter", ["code", "instance", "job"]],
    ],
  );
  assert.doesNotMatch(
    described.text,
    /prometheus\.internal|PROM_TOKEN|bearer|url|canManage/,
  );
});

test("validate_sql takes PromQL for a Prometheus source, with the guard's hints", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const ok = await call(tools, "validate_sql", {
    sourceId: "src-prom",
    promql: "sum(rate(http_requests_total[5m]))",
  });
  assert.deepEqual(ok.data, { ok: true });
  const hinted = await call(tools, "validate_sql", {
    sourceId: "src-prom",
    promql: "rate(up[5m])",
  });
  assert.equal(hinted.data.ok, true);
  assert.match(String((hinted.data.hints as string[])[0]), /a gauge/);
  const refused = await call(tools, "validate_sql", {
    sourceId: "src-prom",
    promql: "secret_metric",
  });
  assert.equal(refused.data.ok, false);
  // The wrong language for the source is refused by name.
  const wrong = await call(tools, "validate_sql", {
    sourceId: "src-prom",
    sql: "SELECT 1",
  });
  assert.equal(wrong.data.ok, false);
  assert.match(String(wrong.data.error), /answers PromQL; this query is SQL/);
  const sqlSource = await call(tools, "validate_sql", {
    sourceId: "src-app",
    promql: "up",
  });
  assert.match(String(sqlSource.data.error), /answers SQL; this query is PromQL/);
});

test("exactly one language per call, and the options of the other are refused", async () => {
  const tools = mcpTools(fakeDeps().deps);
  const both = await call(tools, "validate_sql", {
    sourceId: "src-prom",
    sql: "SELECT 1",
    promql: "up",
  });
  assert.equal(both.ok, false);
  assert.match(both.text, /exactly one of sql and promql/);
  const neither = await call(tools, "validate_sql", { sourceId: "src-prom" });
  assert.equal(neither.ok, false);
  const instantSql = await call(tools, "run_query", {
    sourceId: "src-app",
    sql: "SELECT 1",
    instant: true,
  });
  assert.equal(instantSql.ok, false);
  assert.match(instantSql.text, /for promql only/);
  const timeFieldPromql = await call(tools, "run_query", {
    sourceId: "src-prom",
    promql: "up",
    timeField: "ts",
  });
  assert.equal(timeFieldPromql.ok, false);
  assert.match(timeFieldPromql.text, /timeField is for sql only/);
});

test("run_query runs PromQL through the plan the server builds, and audits the expression", async () => {
  const { deps, calls } = fakeDeps();
  const tools = mcpTools(deps);
  const ran = await call(tools, "run_query", {
    sourceId: "src-prom",
    promql: "sum by (job) (rate(http_requests_total[5m]))",
    timeRange: { from: "now-1h", to: "now" },
    minStep: "1m",
  });
  assert.ok(ran.ok, ran.text);
  assert.deepEqual(ran.data.columns, ["time", '{job="api"}']);
  assert.equal(calls.promql.length, 1);
  const plan = calls.promql[0];
  assert.equal(plan.instant, false);
  assert.ok(!plan.instant && plan.stepSeconds >= 60);
  assert.equal(calls.executed.length, 0);

  const instant = await call(tools, "run_query", {
    sourceId: "src-prom",
    promql: "sum(up)",
    instant: true,
  });
  assert.ok(instant.ok, instant.text);
  assert.equal(calls.promql[1].instant, true);
});

test("generate_source drafts the kind it is asked for, and refuses a draft of the other", async () => {
  const promDraft = {
    id: "prom",
    name: "Prom",
    config: {
      kind: "prometheus",
      url: "https://prometheus.example.com",
      auth: "none",
      metrics: [{ name: "up", type: "gauge", labels: ["job"] }],
    },
  };
  const { deps } = fakeDeps({}, [{ object: promDraft }, { object: promDraft }]);
  const tools = mcpTools(deps);
  const drafted = await call(
    tools,
    "generate_source",
    { workspaceId: "ws-1", prompt: "our Prometheus", kind: "prometheus" },
    admin,
  );
  assert.ok(drafted.ok, drafted.text);
  const other = await call(
    tools,
    "generate_source",
    { workspaceId: "ws-1", prompt: "our database", kind: "timescaledb" },
    admin,
  );
  assert.equal(other.ok, false);
  assert.match(other.text, /drafted a Prometheus source, not a TimescaleDB one/);
});
