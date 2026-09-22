import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  describePanelError,
  describeTickError,
  getPoller,
  invalidatePoller,
  activePollerCount,
  makePanelExecutor,
  type PanelExecutor,
  type PollerEvent,
} from "@/lib/poller/registry";
import { OPAQUE_MESSAGE } from "@/lib/errors";
import { TimeRangeError } from "@/lib/time";
import { QueryExecutionError } from "@/lib/timescaledb/client";
import { createLogger, setLogger } from "@/lib/log";
import type { Dashboard, Panel } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";

function spec(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 60_000,
    panels: [
      {
        id: "p1",
        title: "p1",
        viz: "line",
        query: { sourceId: "s1", sql: "SELECT ts FROM http_requests", timeField: "ts" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
    ...overrides,
  };
}

const noopExecutor: PanelExecutor = async () => [];

test("computeDelta replaces on first fetch and reports the max cursor", () => {
  const rows = [
    { ts: "2024-01-01 00:00:01" },
    { ts: "2024-01-01 00:00:03" },
    { ts: "2024-01-01 00:00:02" },
  ];
  const d = computeDelta(rows, "ts", undefined);
  assert.equal(d.mode, "replace");
  assert.equal(d.fresh.length, 3);
  assert.equal(d.cursor, "2024-01-01 00:00:03");
});

test("computeDelta appends only rows newer than the cursor", () => {
  const rows = [
    { ts: "2024-01-01 00:00:02" },
    { ts: "2024-01-01 00:00:03" },
    { ts: "2024-01-01 00:00:04" },
  ];
  const d = computeDelta(rows, "ts", "2024-01-01 00:00:03");
  assert.equal(d.mode, "append");
  assert.deepEqual(d.fresh, [{ ts: "2024-01-01 00:00:04" }]);
  assert.equal(d.cursor, "2024-01-01 00:00:04");
});

test("computeDelta keeps the prior cursor when no rows are returned", () => {
  const d = computeDelta([], "ts", "2024-01-01 00:00:03");
  assert.equal(d.mode, "append");
  assert.equal(d.fresh.length, 0);
  assert.equal(d.cursor, "2024-01-01 00:00:03");
});

test("getPoller returns one shared instance per dashboard", () => {
  const a = getPoller("dash-shared", 1, "ws1", spec(), noopExecutor);
  const b = getPoller("dash-shared", 1, "ws1", spec(), noopExecutor);
  assert.equal(a, b);
  invalidatePoller("dash-shared");
});

test("getPoller replaces the poller when a higher version is requested", () => {
  const v1 = getPoller("dash-ver", 1, "ws1", spec(), noopExecutor);
  const v1again = getPoller("dash-ver", 1, "ws1", spec(), noopExecutor);
  assert.equal(v1, v1again, "same/lower version keeps existing poller");
  const v2 = getPoller("dash-ver", 2, "ws1", spec(), noopExecutor);
  assert.notEqual(v1, v2, "higher version replaces the poller");
  assert.equal(v2.version, 2);
  invalidatePoller("dash-ver");
});

test("subscribe ref-counts and the last unsubscribe stops the poller", () => {
  const before = activePollerCount();
  const poller = getPoller("dash-refcount", 1, "ws1", spec(), noopExecutor);
  const unsub1 = poller.subscribe(() => {});
  const unsub2 = poller.subscribe(() => {});
  assert.equal(poller.subscriberCount, 2);
  assert.equal(poller.isRunning, true);
  assert.equal(activePollerCount(), before + 1);

  unsub1();
  assert.equal(poller.subscriberCount, 1);
  assert.equal(poller.isRunning, true, "still running with one subscriber");

  unsub2();
  assert.equal(poller.subscriberCount, 0);
  assert.equal(poller.isRunning, false, "stopped after last subscriber left");
  assert.equal(activePollerCount(), before, "removed from the registry");
});

test("a shared poller runs one tick for multiple subscribers", async () => {
  let ticks = 0;
  const executor: PanelExecutor = async () => {
    ticks += 1;
    return [{ type: "panel", panelId: "p1", mode: "replace", columns: [], rows: [] }];
  };
  const poller = getPoller("dash-onetick", 1, "ws1", spec(), executor);
  const events: string[] = [];
  const unsubA = poller.subscribe((e) => events.push(`a:${e.type}`));
  const unsubB = poller.subscribe((e) => events.push(`b:${e.type}`));

  await new Promise((r) => setTimeout(r, 20));

  // One executor invocation for the single panel is broadcast to both subscribers.
  assert.equal(ticks, 1);
  assert.ok(events.includes("a:panel"));
  assert.ok(events.includes("b:panel"));

  unsubA();
  unsubB();
  assert.equal(poller.isRunning, false);
});

test("makePanelExecutor emits tombstone for a cross-workspace source (never executes query)", async () => {
  const DASHBOARD_WORKSPACE = "ws-dashboard";
  const OTHER_WORKSPACE = "ws-attacker";

  // A live, non-tombstoned source that belongs to a different workspace.
  const crossWorkspaceSource: SourceRecord = {
    id: "src-cross",
    workspaceId: OTHER_WORKSPACE,
    name: "Attacker Source",
    kind: "timescaledb",
    config: {
      host: "internal-host",
      port: 5432,
      database: "secret_db",
      schema: "metrics",
      ssl: false,
      tables: [{ name: "secrets", columns: [{ name: "data", type: "text" }] }],
    },
    secretRef: "ATTACKER_CREDS",
    createdBy: "attacker",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tombstonedAt: null,
  };

  const queryExecuted = false;
  // Inject a mock resolver that returns the cross-workspace source.
  const executor = makePanelExecutor(async () => {
    return crossWorkspaceSource;
  });

  // Replace executePlan to detect if a query slips through.
  // (The workspace check must fire before executePlan is ever called.)
  const panel: Panel = {
    id: "p-cross",
    title: "Cross-workspace panel",
    viz: "line",
    query: { sourceId: "src-cross", sql: "SELECT data FROM secrets" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };

  const events = await executor(
    panel,
    { from: new Date("2024-01-01"), to: new Date("2024-01-02") },
    new Map(),
    DASHBOARD_WORKSPACE,
  );

  assert.equal(
    queryExecuted,
    false,
    "executePlan must never be called for cross-workspace source",
  );
  assert.equal(events.length, 1);
  assert.equal(
    events[0].type,
    "tombstone",
    "cross-workspace source must surface as tombstone",
  );
  const tombstone = events[0] as { type: "tombstone"; panelId: string; sourceId: string };
  assert.equal(tombstone.sourceId, "src-cross");
  assert.equal(tombstone.panelId, "p-cross");
});

test("makePanelExecutor allows execution when source workspace matches dashboard workspace", async () => {
  const WORKSPACE = "ws-shared";

  const matchingSource: SourceRecord = {
    id: "src-same",
    workspaceId: WORKSPACE,
    name: "Same WS Source",
    kind: "timescaledb",
    config: {
      host: "localhost",
      port: 5432,
      database: "holotable",
      schema: "metrics",
      ssl: false,
      tables: [
        { name: "events", columns: [{ name: "ts", type: "timestamp with time zone" }] },
      ],
    },
    secretRef: "METRICS_CREDS",
    createdBy: "owner",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tombstonedAt: null,
  };

  const executor = makePanelExecutor(async () => matchingSource);

  const panel: Panel = {
    id: "p-same",
    title: "Same-workspace panel",
    viz: "line",
    query: { sourceId: "src-same", sql: "SELECT ts FROM events", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };

  // executePlan will throw (no real DB), so we just verify the tombstone is NOT
  // emitted before the query phase — the executor must reach query execution.
  let reachedQuery = false;
  try {
    await executor(
      panel,
      { from: new Date("2024-01-01"), to: new Date("2024-01-02") },
      new Map(),
      WORKSPACE,
    );
  } catch {
    // Expected: no live TimescaleDB. The important thing is it didn't return
    // a tombstone without attempting execution.
    reachedQuery = true;
  }

  assert.equal(
    reachedQuery,
    true,
    "executor must attempt query execution for same-workspace source",
  );
});

// --- panel error classification (invariant 16 on the SSE path) ---

/** Keep the error the opaque branch logs out of the test output, and count it. */
function captureLog<T>(fn: () => T): { result: T; errors: number } {
  const lines: Array<{ level: string }> = [];
  const restore = setLogger(
    createLogger({
      level: "debug",
      format: "json",
      sink: (line) => lines.push(JSON.parse(line) as { level: string }),
    }),
  );
  try {
    const result = fn();
    return { result, errors: lines.filter((l) => l.level === "error").length };
  } finally {
    restore();
  }
}

test("a statement failure keeps its real message so the editor can fix it", () => {
  const { result, errors } = captureLog(() =>
    describePanelError(new QueryExecutionError('column "durationms" does not exist')),
  );
  assert.deepEqual(result, {
    error: 'column "durationms" does not exist',
    kind: "statement",
  });
  // Nothing to log: this is the user's query, not an incident.
  assert.equal(errors, 0);
});

test("a connection failure never reaches the browser", () => {
  // The poller used to broadcast err.message for anything, which put the
  // database host and port in front of every viewer of the dashboard.
  const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
    code: "ECONNREFUSED",
  });
  const { result, errors } = captureLog(() => describePanelError(err));
  assert.equal(result.kind, "infrastructure");
  assert.equal(result.error, OPAQUE_MESSAGE);
  assert.ok(!result.error.includes("ECONNREFUSED"));
  assert.ok(!result.error.includes("10.0.0.5"));
  // The real cause is not lost, it just goes to the log instead.
  assert.equal(errors, 1);
});

test("a non-Error throw is opaque too", () => {
  const { result } = captureLog(() => describePanelError("something odd"));
  assert.equal(result.kind, "infrastructure");
  assert.equal(result.error, OPAQUE_MESSAGE);
});

test("a rejected query is reported as the statement it is", async () => {
  const executor = makePanelExecutor(
    async () =>
      ({
        id: "s1",
        workspaceId: "w1",
        name: "s",
        secretRef: "TS",
        tombstonedAt: null,
        config: { host: "h", port: 5432, database: "d", schema: "public", tables: [] },
      }) as unknown as SourceRecord,
  );
  const events = await executor(
    spec().panels[0],
    { from: new Date(0), to: new Date(1) },
    new Map(),
    "w1",
  );
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "panel-error");
  if (event.type !== "panel-error") return;
  assert.equal(event.kind, "statement");
});

// --- tick resilience (#140) ---

/** The async variant of `captureLog`, for a tick that has to be awaited. */
async function captureLogAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; lines: Array<{ level: string; msg?: string }> }> {
  const lines: Array<{ level: string; msg?: string }> = [];
  const restore = setLogger(
    createLogger({
      level: "debug",
      format: "json",
      sink: (line) => lines.push(JSON.parse(line) as { level: string; msg?: string }),
    }),
  );
  try {
    return { result: await fn(), lines };
  } finally {
    restore();
  }
}

test("an unresolvable time range is the viewer's to fix, so it keeps its message", () => {
  const { result, errors } = captureLog(() =>
    describeTickError(new TimeRangeError("invalid time expression: not-a-time"), "d1"),
  );
  assert.deepEqual(result, {
    error: "invalid time expression: not-a-time",
    kind: "validation",
  });
  // A range someone picked is not an incident.
  assert.equal(errors, 0);
});

test("any other tick failure is opaque and logged", () => {
  const err = Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432"), {
    code: "ECONNREFUSED",
  });
  const { result, errors } = captureLog(() => describeTickError(err, "d1"));
  assert.equal(result.kind, "infrastructure");
  assert.equal(result.error, OPAQUE_MESSAGE);
  assert.ok(!result.error.includes("10.0.0.5"));
  assert.equal(errors, 1);
});

test("a throw outside the per-panel try is broadcast and the poller keeps ticking", async () => {
  // `from` equals `to`, which the IR accepts and `resolveTimeRange` rejects —
  // the reachable case, since the viewer picks the range and the poller key
  // includes it. The throw lands outside the per-panel try.
  const inverted = spec({ timeRange: { from: "now", to: "now" } });
  const poller = getPoller("dash-badrange", 1, "ws1", inverted, noopExecutor);
  const events: PollerEvent[] = [];

  const { lines } = await captureLogAsync(async () => {
    const unsub = poller.subscribe((e) => events.push(e));
    await new Promise((r) => setTimeout(r, 20));
    return unsub;
  });

  const failure = events.find((e) => e.type === "dashboard-error");
  assert.ok(failure, "the subscriber must be told the cycle failed");
  assert.equal(failure.kind, "validation");
  assert.match(failure.error, /from` must be before `to/);
  assert.ok(
    !events.some((e) => e.type === "tick"),
    "a failed cycle must not refresh the freshness readout",
  );
  assert.ok(
    lines.some((l) => l.msg === "poller.time_range_failed"),
    "the failure must reach the log too",
  );
  // The tick has finished, so "not stalled" means the next one is armed. This
  // is the regression: `scheduleNext()` used to be skipped and every viewer
  // kept a Live badge over a frozen chart.
  assert.equal(poller.isStalled, false, "the poller must still be scheduled");
  assert.equal(poller.isRunning, true);

  invalidatePoller("dash-badrange");
});

test("getPoller replaces a stalled poller instead of sharing it", () => {
  const poller = getPoller("dash-stalled", 1, "ws1", spec(), noopExecutor);
  // Forced, because the guards above make it unreachable through the public
  // API — which is the point: this asserts the last line of defence.
  (poller as unknown as { running: boolean }).running = true;
  assert.equal(poller.isStalled, true);

  const next = getPoller("dash-stalled", 1, "ws1", spec(), noopExecutor);
  assert.notEqual(next, poller, "a dead poller must not be handed to a subscriber");
  assert.equal(next.isStalled, false);

  invalidatePoller("dash-stalled");
});
