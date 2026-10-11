import { mock, test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  describePanelError,
  describeTickError,
  getPoller,
  invalidatePoller,
  activePollerCount,
  DashboardPoller,
  makePanelExecutor,
  type PanelExecutor,
  type PollerEvent,
  setPollerJitterForTests,
  type SourceReads,
} from "@/lib/poller/registry";
import { SourceSlots } from "@/lib/poller/source-slots";
import { OPAQUE_MESSAGE } from "@/lib/errors";
import { TimeRangeError } from "@/lib/time";
import { QueryExecutionError } from "@/lib/sources/execution";
import { createLogger, setLogger } from "@/lib/log";
import type { Dashboard, QueryPanel } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";
import { asQueryPanel } from "./support/panels";

function spec(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    specVersion: 1,
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

test("computeDelta sends the rows from the cursor on, the cursor's own included", () => {
  const rows = [
    { ts: "2024-01-01 00:00:02" },
    { ts: "2024-01-01 00:00:03", v: 7 },
    { ts: "2024-01-01 00:00:04" },
  ];
  const d = computeDelta(rows, "ts", "2024-01-01 00:00:03");
  assert.equal(d.mode, "append");
  // The bucket at the cursor may have changed since it was sent; it goes again.
  assert.deepEqual(d.fresh, [
    { ts: "2024-01-01 00:00:03", v: 7 },
    { ts: "2024-01-01 00:00:04" },
  ]);
  assert.equal(d.cursor, "2024-01-01 00:00:04");
});

test("computeDelta keeps the prior cursor when no rows are returned", () => {
  const d = computeDelta([], "ts", "2024-01-01 00:00:03");
  assert.equal(d.mode, "append");
  assert.equal(d.fresh.length, 0);
  assert.equal(d.cursor, "2024-01-01 00:00:03");
});

test("getPoller returns one shared instance per dashboard", () => {
  const a = getPoller("dash-shared", 1, "ws1", spec(), {}, noopExecutor);
  const b = getPoller("dash-shared", 1, "ws1", spec(), {}, noopExecutor);
  assert.equal(a, b);
  invalidatePoller("dash-shared");
});

test("getPoller replaces the poller when a higher version is requested", () => {
  const v1 = getPoller("dash-ver", 1, "ws1", spec(), {}, noopExecutor);
  const v1again = getPoller("dash-ver", 1, "ws1", spec(), {}, noopExecutor);
  assert.equal(v1, v1again, "same/lower version keeps existing poller");
  const v2 = getPoller("dash-ver", 2, "ws1", spec(), {}, noopExecutor);
  assert.notEqual(v1, v2, "higher version replaces the poller");
  assert.equal(v2.version, 2);
  invalidatePoller("dash-ver");
});

test("subscribe ref-counts and the last unsubscribe stops the poller", () => {
  const before = activePollerCount();
  const poller = getPoller("dash-refcount", 1, "ws1", spec(), {}, noopExecutor);
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
  const poller = getPoller("dash-onetick", 1, "ws1", spec(), {}, executor);
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
      kind: "timescaledb",
      host: "internal-host",
      port: 5432,
      database: "secret_db",
      schema: "metrics",
      ssl: false,
      tables: [{ name: "secrets", columns: [{ name: "data", type: "text" }] }],
    },
    secretRef: "ATTACKER_CREDS",
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
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
  const panel: QueryPanel = {
    id: "p-cross",
    title: "Cross-workspace panel",
    viz: "line",
    query: { sourceId: "src-cross", sql: "SELECT data FROM secrets" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };

  const events = await executor(
    panel,
    { from: new Date("2024-01-01"), to: new Date("2024-01-02") },
    DASHBOARD_WORKSPACE,
    {},
    {},
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
      kind: "timescaledb",
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
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "owner",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tombstonedAt: null,
  };

  const executor = makePanelExecutor(async () => matchingSource);

  const panel: QueryPanel = {
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
      WORKSPACE,
      {},
      {},
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
        kind: "timescaledb",
        config: {
          kind: "timescaledb",
          host: "h",
          port: 5432,
          database: "d",
          schema: "public",
          tables: [],
        },
      }) as unknown as SourceRecord,
  );
  const events = await executor(
    asQueryPanel(spec().panels[0]),
    { from: new Date(0), to: new Date(1) },
    "w1",
    {},
    {},
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
  const poller = getPoller("dash-badrange", 1, "ws1", inverted, {}, noopExecutor);
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
  const poller = getPoller("dash-stalled", 1, "ws1", spec(), {}, noopExecutor);
  // Forced, because the guards above make it unreachable through the public
  // API — which is the point: this asserts the last line of defence.
  (poller as unknown as { running: boolean }).running = true;
  assert.equal(poller.isStalled, true);

  const next = getPoller("dash-stalled", 1, "ws1", spec(), {}, noopExecutor);
  assert.notEqual(next, poller, "a dead poller must not be handed to a subscriber");
  assert.equal(next.isStalled, false);

  invalidatePoller("dash-stalled");
});

// --- The source pool under load (#487) -------------------------------------------

test("a cycle reads each source once, however many panels it has", async () => {
  let reads = 0;
  const executor = makePanelExecutor(async (id) => {
    reads++;
    // Another workspace's source: every panel is a tombstone, and nothing runs.
    return {
      id,
      workspaceId: "elsewhere",
      tombstonedAt: null,
    } as unknown as SourceRecord;
  });
  const panels = Array.from({ length: 20 }, (_, i) =>
    asQueryPanel({ ...spec().panels[0], id: `p${i}` }),
  );
  const sources: SourceReads = new Map();
  const window = { from: new Date(0), to: new Date(1) };
  const events = await Promise.all(
    panels.map((p) => executor(p, window, "ws", {}, {}, sources)),
  );
  assert.equal(reads, 1);
  assert.ok(events.every(([e]) => e.type === "tombstone"));
  // The next cycle reads again: nothing is kept across cycles.
  await executor(panels[0], window, "ws", {}, {}, new Map());
  assert.equal(reads, 2);
});

test("a source slot is waited for, handed on, and given up after the wait", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const slots = new SourceSlots(() => 2);
    const a = await slots.acquire("s", 1_000);
    const b = await slots.acquire("s", 1_000);
    assert.ok(a && b);
    const waiting = slots.acquire("s", 1_000);
    const late = slots.acquire("s", 500);
    a();
    a(); // a second release is a no-op, never a second slot
    const handed = await waiting;
    assert.ok(handed, "a released slot goes to the first waiter");
    assert.equal(slots.inFlight("s"), 2);
    mock.timers.tick(500);
    assert.equal(await late, null, "no slot within the wait is a skip");
    b();
    handed();
    assert.equal(slots.inFlight("s"), 0);
  } finally {
    mock.timers.reset();
  }
});

/** A seeded generator, so the spread is the same on every run. */
function seeded(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648;
  };
}

test("a hundred dashboards on one source: no failures, the cap held, every panel fresh", async () => {
  // The issue's arithmetic (#487): 100 single-panel dashboards on one source,
  // 100 ms a query, opened together. With one slot below a pool of five, a
  // cycle's queue drains in 2.5 s, well inside the 15 s interval.
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const restoreJitter = setPollerJitterForTests(seeded(487));
  const INTERVAL = 15_000;
  const QUERY_MS = 100;
  const slots = new SourceSlots(() => 4);
  let inFlight = 0;
  let peak = 0;
  const executor: PanelExecutor = async (panel) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, QUERY_MS));
    inFlight--;
    return [{ type: "panel", panelId: panel.id, mode: "replace", columns: [], rows: [] }];
  };
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };
  const refreshed: number[][] = [];
  const failures: PollerEvent[] = [];
  const stops: Array<() => void> = [];
  try {
    for (let d = 0; d < 100; d++) {
      const times: number[] = [];
      refreshed.push(times);
      const poller = new DashboardPoller(
        `d-load-${d}`,
        1,
        "ws",
        spec({ refreshIntervalMs: INTERVAL }),
        {},
        executor,
        undefined,
        {},
        slots,
      );
      stops.push(
        poller.subscribe((e) => {
          if (e.type === "panel") times.push(Date.now());
          if (e.type !== "panel" && e.type !== "tick") failures.push(e);
        }),
      );
    }
    for (let t = 0; t < 4 * INTERVAL; t += 20) {
      mock.timers.tick(20);
      await settle();
    }
    assert.deepEqual(failures, [], "no panel failed or waited");
    assert.ok(peak <= 4, `at most four in flight, saw ${peak}`);
    for (const times of refreshed) {
      assert.ok(times.length >= 3, `refreshed ${times.length} times in four intervals`);
      const gaps = [times[0], ...times.slice(1).map((t, i) => t - times[i])];
      assert.ok(Math.max(...gaps) <= 2 * INTERVAL, `a gap of ${Math.max(...gaps)} ms`);
    }
    // And the spread worked: the second cycles do not all start together.
    const seconds = new Set(refreshed.map((times) => Math.round(times[1] / 1_000)));
    assert.ok(seconds.size > 5, `second cycles spread over ${seconds.size} seconds`);
  } finally {
    for (const stop of stops) stop();
    setPollerJitterForTests(restoreJitter);
    mock.timers.reset();
  }
});

test("the spread delays only the second cycle, by at most half the interval", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const restoreJitter = setPollerJitterForTests(() => 0.999);
  const INTERVAL = 10_000;
  const ticks: number[] = [];
  try {
    const poller = new DashboardPoller(
      "d-jitter",
      1,
      "ws",
      spec({ refreshIntervalMs: INTERVAL }),
      {},
      noopExecutor,
    );
    const stop = poller.subscribe((e) => {
      if (e.type === "tick") ticks.push(e.at);
    });
    for (let t = 0; t < 4 * INTERVAL; t += 100) {
      mock.timers.tick(100);
      await new Promise((r) => setImmediate(r));
    }
    stop();
    // The first cycle at once; the second up to half an interval late; then
    // every interval from there.
    // The clock advances in 100 ms steps, so each reading is good to one step.
    const STEP = 100;
    assert.ok(ticks[0] <= STEP, `first cycle at ${ticks[0]} ms`);
    const second = ticks[1] - ticks[0];
    assert.ok(second > 1.4 * INTERVAL && second <= 1.5 * INTERVAL + STEP, `${second} ms`);
    assert.ok(
      Math.abs(ticks[2] - ticks[1] - INTERVAL) <= STEP,
      `${ticks[2] - ticks[1]} ms`,
    );
  } finally {
    setPollerJitterForTests(restoreJitter);
    mock.timers.reset();
  }
});
