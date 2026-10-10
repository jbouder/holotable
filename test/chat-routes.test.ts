import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { UIMessage } from "ai";
import { chatSource, recordingExecutor } from "./support/chat";
import { sqlPlanOf } from "./support/plans";
import { buildDataChatPrompt } from "@/lib/ai/data-chat";
import type { Dashboard } from "@/lib/ir";
import {
  conversationContext,
  conversationScope,
  conversationTitle,
  ownConversation,
  PanelRunBody,
  requestedSources,
  requireUsable,
  runStoredPanel,
  storedPanel,
  TurnBody,
  usableSources,
} from "@/lib/chat/conversations";
import type { Conversation } from "@/lib/db/conversations";
import { HttpError } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import { shareIdentity } from "@/lib/auth/share";

/**
 * What the `/api/chat` routes decide (#416), through the functions they are
 * thin over: whose conversation it is, which sources it may use, and what a
 * panel run is allowed to be sent.
 */

const alice = parseGroups("alice", ["/workspaces/ws-1/viewer"]);
const bob = parseGroups("bob", ["/workspaces/ws-1/viewer"]);
const admin = { ...parseGroups("root", []), platformAdmin: true };
const outsider = parseGroups("eve", ["/workspaces/ws-2/viewer"]);

const metrics = chatSource("src-metrics", "ws-1");
const logs = chatSource("src-logs", "ws-1", "app_logs");
const foreign = chatSource("src-foreign", "ws-2", "payroll");
const removed = { ...chatSource("src-removed", "ws-1"), tombstonedAt: "2026-01-02" };
const registry = new Map([metrics, logs, foreign, removed].map((s) => [s.id, s]));
const getSource = async (id: string) => registry.get(id) ?? null;

const conversation: Conversation = {
  id: "9b1e4f5a-1c2d-4e3f-8a9b-0c1d2e3f4a5b",
  workspaceId: "ws-1",
  sourceIds: ["src-metrics"],
  dashboardId: null,
  title: "",
  timeRange: { from: "2026-07-11T11:00:00.000Z", to: "2026-07-11T12:00:00.000Z" },
  variables: null,
  createdAt: "2026-07-11T12:00:00.000Z",
  updatedAt: "2026-07-11T12:00:00.000Z",
};

/** A store holding alice's one conversation, keyed as the real one is. */
const store = {
  async get(id: string, userSub: string) {
    return id === conversation.id && userSub === "alice" ? conversation : null;
  },
};

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    if (err instanceof HttpError) return err.status;
    throw err;
  }
}

/* --- Ownership ------------------------------------------------------------- */

test("a conversation is its owner's: anyone else, a platform admin too, gets a 404", async () => {
  assert.equal(
    (await ownConversation(conversation.id, alice, store)).id,
    conversation.id,
  );
  assert.equal(await status(ownConversation(conversation.id, bob, store)), 404);
  assert.equal(await status(ownConversation(conversation.id, admin, store)), 404);
  assert.equal(await status(ownConversation("not-a-uuid", alice, store)), 404);
});

test("every conversation route takes the subject from the session, never the request", () => {
  for (const path of [
    "chat",
    "chat/[id]",
    "chat/[id]/messages",
    "chat/[id]/panels/[panelId]/run",
  ]) {
    const source = readFileSync(
      new URL(`../src/app/api/${path}/route.ts`, import.meta.url),
      "utf8",
    );
    assert.match(source, /requireIdentity\(\)/, path);
    assert.match(source, /identity\.sub/, path);
    assert.doesNotMatch(
      source,
      /userSub: body|body\.userSub|searchParams\.get\("sub"\)/,
      path,
    );
    // A share link resolves only through the stream and the embed (#65).
    assert.doesNotMatch(source, /share-access|getIdentity\(/, path);
  }
});

/* --- Which sources -------------------------------------------------------- */

test("a conversation is made over sources the caller may use, in one workspace", async () => {
  const made = await requestedSources({
    identity: alice,
    sourceIds: ["src-metrics", "src-logs"],
    getSource,
  });
  assert.equal(made.workspaceId, "ws-1");
  assert.deepEqual(
    made.sources.map((s) => s.id),
    ["src-metrics", "src-logs"],
  );

  // Another workspace's source: refused by can(), whatever the body says.
  assert.equal(
    await status(
      requestedSources({ identity: alice, sourceIds: ["src-foreign"], getSource }),
    ),
    403,
  );
  assert.equal(
    await status(
      requestedSources({ identity: alice, sourceIds: ["src-removed"], getSource }),
    ),
    400,
  );
  assert.equal(
    await status(requestedSources({ identity: alice, sourceIds: ["nope"], getSource })),
    400,
  );
});

test("one conversation never spans two workspaces", async () => {
  const both = parseGroups("both", [
    "/workspaces/ws-1/viewer",
    "/workspaces/ws-2/viewer",
  ]);
  assert.equal(
    await status(
      requestedSources({
        identity: both,
        sourceIds: ["src-metrics", "src-foreign"],
        getSource,
      }),
    ),
    400,
  );
  // Changing a conversation's sources keeps it in its workspace.
  assert.equal(
    await status(
      requestedSources({
        identity: both,
        sourceIds: ["src-foreign"],
        getSource,
        workspaceId: "ws-1",
      }),
    ),
    400,
  );
});

test("a share link's identity cannot start a conversation", async () => {
  const shared = shareIdentity({
    shareId: "s1",
    dashboardId: "d1",
    workspaceId: "ws-1",
  });
  assert.equal(
    await status(
      requestedSources({ identity: shared, sourceIds: ["src-metrics"], getSource }),
    ),
    403,
  );
});

test("a viewer who lost the workspace finds the conversation read-only, not gone", async () => {
  const { sources, unavailable } = await usableSources({
    identity: outsider,
    conversation,
    getSource,
  });
  assert.deepEqual(sources, []);
  assert.deepEqual(unavailable, ["src-metrics"]);
  assert.throws(
    () => requireUsable(sources),
    (err) => (err as HttpError).status === 403,
  );
});

test("a source moved, removed or gone is left out of a turn, by id", async () => {
  const { sources, unavailable } = await usableSources({
    identity: alice,
    conversation: {
      workspaceId: "ws-1",
      sourceIds: ["src-metrics", "src-removed", "src-foreign", "nope"],
    },
    getSource,
  });
  assert.deepEqual(
    sources.map((s) => s.id),
    ["src-metrics"],
  );
  assert.deepEqual(unavailable, ["src-removed", "src-foreign", "nope"]);
});

/* --- What a turn and a run are sent --------------------------------------- */

test("a turn takes the new question only, as text", () => {
  const ok = TurnBody.safeParse({
    message: { id: "u1", role: "user", parts: [{ type: "text", text: "p95 by route?" }] },
  });
  assert.equal(ok.success, true);
  for (const bad of [
    { messages: [] },
    { message: { id: "a1", role: "assistant", parts: [{ type: "text", text: "x" }] } },
    {
      message: {
        id: "u1",
        role: "user",
        parts: [{ type: "tool-showPanel", input: {}, output: { rows: [] } }],
      },
    },
    {
      message: {
        id: "u1",
        role: "user",
        parts: [{ type: "text", text: "x".repeat(4_001) }],
      },
    },
  ]) {
    assert.equal(
      TurnBody.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 80),
    );
  }
});

test("a panel run is sent a window and nothing else, never a statement", () => {
  assert.equal(PanelRunBody.safeParse({}).success, true);
  assert.equal(
    PanelRunBody.safeParse({ timeRange: { from: "now-6h", to: "now" } }).success,
    true,
  );
  for (const bad of [
    { sql: "SELECT 1" },
    { promql: "up" },
    { query: { sourceId: "src-metrics", sql: "SELECT 1" } },
    { sourceId: "src-foreign" },
  ]) {
    assert.equal(PanelRunBody.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a conversation is titled from its first question, clamped", () => {
  const ask = (text: string) => ({ parts: [{ type: "text" as const, text }] });
  assert.equal(
    conversationTitle(ask("  p95   latency\nby route  ")),
    "p95 latency by route",
  );
  const long = conversationTitle(ask("x".repeat(200)));
  assert.equal(long?.length, 80);
  assert.equal(conversationTitle({ parts: [] }), undefined);
});

/* --- Running a stored panel ----------------------------------------------- */

const spec = {
  title: "Requests by service",
  viz: "table",
  query: {
    sourceId: "src-metrics",
    sql: "SELECT service, count(*) AS requests FROM http_requests GROUP BY service",
  },
};

function answer(state: string, output: unknown, input: unknown = spec): UIMessage[] {
  return [
    {
      id: "a1",
      role: "assistant",
      parts: [{ type: "tool-showPanel", toolCallId: "c1", state, input, output }],
    },
  ] as unknown as UIMessage[];
}

test("only an accepted, drawable panel is found by its id", () => {
  const drawn = answer("output-available", { ok: true, panelId: "p1" });
  assert.equal(storedPanel(drawn, "p1")?.id, "p1");
  assert.equal(storedPanel(drawn, "p2"), null);
  assert.equal(
    storedPanel(answer("output-available", { ok: false, error: "no" }), "p1"),
    null,
  );
  assert.equal(storedPanel(answer("output-error", undefined), "p1"), null);
  assert.equal(
    storedPanel(
      answer("output-available", { ok: true, panelId: "p1" }, { viz: "nope" }),
      "p1",
    ),
    null,
  );
  // A user message cannot plant a panel.
  const planted = drawn.map((m) => ({ ...m, role: "user" })) as UIMessage[];
  assert.equal(storedPanel(planted, "p1"), null);
});

test("a stored panel runs under the window asked for, resolved by the server", async () => {
  const panel = storedPanel(
    answer("output-available", { ok: true, panelId: "p1" }),
    "p1",
  );
  assert.ok(panel);
  const exec = recordingExecutor([{ service: "api", requests: 3 }]);
  const outcomes: string[] = [];
  const run = await runStoredPanel({
    panel,
    scope: conversationScope(conversation, [metrics], alice, {
      from: "2026-07-10T00:00:00.000Z",
      to: "2026-07-10T06:00:00.000Z",
    }),
    execute: exec.execute,
    onQuery: (o) => outcomes.push(o),
  });
  assert.deepEqual(run.rows, [{ service: "api", requests: 3 }]);
  assert.deepEqual(run.window, {
    from: Date.parse("2026-07-10T00:00:00.000Z"),
    to: Date.parse("2026-07-10T06:00:00.000Z"),
  });
  assert.match(sqlPlanOf(exec.plans[0]).sql, /\bLIMIT \d+$/);
  assert.deepEqual(outcomes, ["success"]);
});

test("a stored panel is checked against the catalog as it is now", async () => {
  const panel = storedPanel(
    answer("output-available", { ok: true, panelId: "p1" }),
    "p1",
  );
  assert.ok(panel);
  // The source's catalog no longer has the table the panel was drawn from.
  const narrowed = { ...metrics, config: logs.config };
  const exec = recordingExecutor();
  const outcomes: string[] = [];
  const refused = runStoredPanel({
    panel,
    scope: conversationScope(conversation, [narrowed], alice),
    execute: exec.execute,
    onQuery: (o, stage) => outcomes.push(`${o}:${stage}`),
  });
  assert.equal(await status(refused), 400);
  assert.equal(exec.plans.length, 0);
  assert.deepEqual(outcomes, ["failure:validate"]);
});

/* --- A conversation that continues a dashboard's chat (#416, phase 6) ------ */

const board = {
  id: "0d8f5a3e-0000-4000-8000-000000000001",
  workspaceId: "ws-1",
  spec: {
    specVersion: 1,
    title: "Traffic",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    variables: [
      { name: "service", label: "Service", type: "enum", values: ["api", "web"] },
    ],
    panels: [
      {
        id: "p1",
        title: "Requests",
        viz: "table",
        query: {
          sourceId: "src-metrics",
          sql: "SELECT service, count(*) FROM http_requests WHERE service = :service GROUP BY service",
        },
        layout: { x: 0, y: 0, w: 12, h: 4 },
      },
    ],
  },
} as unknown as { id: string; workspaceId: string; spec: Dashboard };

const onBoard = { workspaceId: "ws-1", sourceIds: [], dashboardId: board.id };
const getDashboard = async (id: string) => (id === board.id ? board : null);

test("a dashboard's conversation queries the dashboard's sources, not its own list", async () => {
  const context = await conversationContext({
    identity: alice,
    conversation: onBoard,
    getSource,
    getDashboard,
  });
  assert.deepEqual(
    context.sources.map((s) => s.id),
    ["src-metrics"],
  );
  assert.equal(context.dashboard?.title, "Traffic");
  // Its queries may use the dashboard's variables, bound to the defaults.
  const scope = conversationScope(
    { timeRange: board.spec.timeRange, variables: null },
    context.sources,
    alice,
    undefined,
    context.dashboard?.spec,
  );
  assert.deepEqual([...(scope.declaredVariables ?? [])], ["service"]);
  assert.deepEqual(scope.variables, { service: "api" });
});

test("a dashboard gone, moved or out of reach leaves its conversation read-only", async () => {
  for (const [identity, getter] of [
    [alice, async () => null],
    [alice, async () => ({ ...board, workspaceId: "ws-2" })],
    [outsider, getDashboard],
  ] as const) {
    const context = await conversationContext({
      identity,
      conversation: onBoard,
      getSource,
      getDashboard: getter,
    });
    assert.deepEqual(context.sources, []);
    assert.equal(context.dashboard, null);
    assert.deepEqual(context.unavailable, [board.id]);
  }
});

test("the Chat prompt carries a dashboard's panels and variables, fenced", () => {
  const prompt = buildDataChatPrompt({
    sources: [metrics],
    timeRange: board.spec.timeRange,
    dashboard: { spec: board.spec },
  });
  assert.match(prompt, /continues the chat on the dashboard "Traffic"/);
  assert.match(prompt, /PANELS/);
  assert.match(prompt, /panel "p1" — Requests/);
  assert.match(prompt, /Variables a query may reference as :name/);
  // Without a dashboard, none of it.
  assert.doesNotMatch(
    buildDataChatPrompt({ sources: [metrics], timeRange: board.spec.timeRange }),
    /PANELS/,
  );
});
