import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { config } from "@/lib/config";
import { cycleMs, type Dashboard, Panel, panelTimeRange } from "@/lib/ir";
import { createLogger, setLogger } from "@/lib/log";
import { getPoller, type PanelExecutor, type PollerEvent } from "@/lib/poller/registry";
import { diffPanels } from "@/lib/panel-diff";
import { mergePanelRows } from "@/lib/stream-merge";
import { panelOverride, supportsTimeBrush } from "@/lib/time-range";

/** A panel's own time range and refresh interval (#114). */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const MINUTE = 60_000;

function panel(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: id,
    viz: "line" as const,
    query: { sourceId: "s1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: LAYOUT,
    ...extra,
  };
}

function issues(input: unknown): string {
  const parsed = Panel.safeParse(input);
  return parsed.success ? "" : parsed.error.issues.map((i) => i.message).join("\n");
}

test("a panel may carry its own window and cadence, under the dashboard's bounds", () => {
  assert.equal(
    issues(
      panel("p", { timeRange: { from: "now-5m", to: "now" }, refreshIntervalMs: 5_000 }),
    ),
    "",
  );
  assert.notEqual(issues(panel("p", { refreshIntervalMs: 500 })), "");
  assert.notEqual(issues(panel("p", { refreshIntervalMs: 7_200_000 })), "");
  assert.notEqual(
    issues(panel("p", { timeRange: { from: "yesterday", to: "now" } })),
    "",
  );
  const text = {
    id: "t",
    title: "Notes",
    viz: "text",
    options: { content: "hi" },
    layout: LAYOUT,
  };
  assert.equal(issues(text), "");
  assert.match(
    issues({ ...text, timeRange: { from: "now-5m", to: "now" } }),
    /runs no query/,
  );
  assert.match(issues({ ...text, refreshIntervalMs: 5_000 }), /runs no query/);
});

test("a panel's window is its own, or the one it is shown in", () => {
  const shown = { from: "now-24h", to: "now" };
  const own = { from: "now-5m", to: "now" };
  assert.deepEqual(panelTimeRange(Panel.parse(panel("a")), shown), shown);
  assert.deepEqual(
    panelTimeRange(Panel.parse(panel("b", { timeRange: own })), shown),
    own,
  );
});

test("a dashboard's cycle is its fastest panel's cadence", () => {
  const spec = { refreshIntervalMs: 30_000, panels: [Panel.parse(panel("a"))] };
  assert.equal(cycleMs(spec), 30_000);
  spec.panels = [
    Panel.parse(panel("a", { refreshIntervalMs: 300_000 })),
    Panel.parse(panel("b", { refreshIntervalMs: 120_000 })),
  ];
  assert.equal(cycleMs(spec), 120_000, "every panel slower: the fastest of them");
  spec.panels.push(Panel.parse(panel("c", { refreshIntervalMs: 5_000 })));
  assert.equal(cycleMs(spec), 5_000);
});

test("a panel on its own window says so, and is not a brush over the dashboard's", () => {
  const own = Panel.parse(
    panel("b", { timeRange: { from: "now-5m", to: "now" }, refreshIntervalMs: 300_000 }),
  );
  assert.deepEqual(panelOverride(own), {
    label: "Last 5m · every 5m",
    description:
      "This panel shows its own window (Last 5m) rather than the dashboard's and refreshes every 5m.",
  });
  assert.equal(panelOverride(Panel.parse(panel("a"))), null);
  assert.equal(supportsTimeBrush(Panel.parse(panel("a"))), true);
  assert.equal(supportsTimeBrush(own), false);
});

test("the window a frame carries is kept with the panel's rows", () => {
  const window = { from: 1, to: 2 };
  const first = mergePanelRows(
    undefined,
    { type: "panel", panelId: "b", mode: "replace", columns: ["v"], rows: [], window },
    10,
  );
  assert.deepEqual(first.window, window);
  const next = mergePanelRows(
    first,
    { type: "panel", panelId: "b", mode: "append", columns: ["v"], rows: [{ v: 1 }] },
    10,
  );
  assert.deepEqual(next.window, window, "a frame without one keeps the last");
});

// ---------------------------------------------------------------------------
// The poller
// ---------------------------------------------------------------------------

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: NOW });
  setLogger(createLogger({ level: "silent" }));
});

afterEach(() => {
  mock.timers.reset();
  setLogger(createLogger());
});

async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

async function advance(ms: number) {
  mock.timers.tick(ms);
  await settle();
}

/** Records each execution: which panel, over what window. */
function recorder() {
  const runs: { panelId: string; from: number; to: number }[] = [];
  const executor: PanelExecutor = async (p, window) => {
    runs.push({ panelId: p.id, from: window.from.getTime(), to: window.to.getTime() });
    return [{ type: "panel", panelId: p.id, mode: "replace", columns: ["v"], rows: [] }];
  };
  const count = (id: string) => runs.filter((r) => r.panelId === id).length;
  return { runs, executor, count };
}

function dashboard(
  panels: ReturnType<typeof panel>[],
  refreshIntervalMs = MINUTE,
): Dashboard {
  return {
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs,
    panels: panels.map((p) => Panel.parse(p)),
  };
}

let n = 0;
const dashboardId = () => `dash-override-${++n}`;

test("a panel with its own window is executed over it, and its frames carry it", async () => {
  const { runs, executor } = recorder();
  const spec = dashboard([
    panel("a"),
    panel("b", { timeRange: { from: "now-5m", to: "now" } }),
  ]);
  const poller = getPoller(dashboardId(), 1, "ws", spec, {}, executor);
  const events: PollerEvent[] = [];
  const stop = poller.subscribe((e) => events.push(e));
  await settle();

  const a = runs.find((r) => r.panelId === "a");
  const b = runs.find((r) => r.panelId === "b");
  assert.deepEqual(a, { panelId: "a", from: NOW - 60 * MINUTE, to: NOW });
  assert.deepEqual(b, { panelId: "b", from: NOW - 5 * MINUTE, to: NOW });

  const frame = events.find(
    (e): e is Extract<PollerEvent, { type: "panel" }> =>
      e.type === "panel" && e.panelId === "b",
  );
  assert.deepEqual(frame?.window, { from: NOW - 5 * MINUTE, to: NOW });
  const tick = events.find((e) => e.type === "tick");
  assert.deepEqual(
    tick?.type === "tick" ? tick.window : undefined,
    { from: NOW - 60 * MINUTE, to: NOW },
    "the tick's window is still the dashboard's",
  );
  stop();
});

test("a panel's own window wins over the one a viewer picked", async () => {
  const { runs, executor } = recorder();
  const spec = {
    ...dashboard([panel("a"), panel("b", { timeRange: { from: "now-5m", to: "now" } })]),
    // What the stream route does with a viewer's range.
    timeRange: { from: "now-7d", to: "now" },
  };
  const stop = getPoller(dashboardId(), 1, "ws", spec, {}, executor).subscribe(() => {});
  await settle();
  assert.equal(runs.find((r) => r.panelId === "a")?.from, NOW - 7 * 24 * 60 * MINUTE);
  assert.equal(runs.find((r) => r.panelId === "b")?.from, NOW - 5 * MINUTE);
  stop();
});

test("a panel with its own cadence runs on it, and panels sharing one run together", async () => {
  const { executor, count } = recorder();
  const spec = dashboard(
    [panel("a"), panel("slow", { refreshIntervalMs: 2 * MINUTE })],
    MINUTE,
  );
  const poller = getPoller(dashboardId(), 1, "ws", spec, {}, executor);
  let ticks = 0;
  const stop = poller.subscribe((e) => {
    if (e.type === "tick") ticks++;
  });
  await settle();
  assert.deepEqual([count("a"), count("slow")], [1, 1]);
  ticks = 0;

  await advance(MINUTE);
  assert.deepEqual([count("a"), count("slow")], [2, 1], "only the minute cadence");
  await advance(MINUTE);
  assert.deepEqual([count("a"), count("slow")], [3, 2], "both, in one cycle");
  assert.equal(ticks, 2, "one cycle a minute, not one per cadence");
  stop();
});

test("a faster panel cadence ticks the dashboard sooner, never below the floor", async () => {
  const { executor, count } = recorder();
  const spec = dashboard(
    [panel("a"), panel("fast", { refreshIntervalMs: 1_000 })],
    MINUTE,
  );
  const stop = getPoller(dashboardId(), 1, "ws", spec, {}, executor).subscribe(() => {});
  await settle();
  assert.equal(count("fast"), 1);

  const floor = config.minRefreshIntervalMs;
  assert.ok(floor > 1_000, "the test needs a floor above the panel's cadence");
  await advance(1_000);
  assert.equal(count("fast"), 1, "1s is under MIN_REFRESH_INTERVAL_MS");
  await advance(floor - 1_000);
  assert.equal(count("fast"), 2, "clamped to the floor");
  assert.equal(count("a"), 1, "the dashboard's cadence is untouched");
  stop();
});

test("a panel whose own window will not resolve fails alone", async () => {
  const { executor, count } = recorder();
  const spec = dashboard([
    panel("a"),
    // Valid expressions, inverted: the IR cannot tell, the server can.
    panel("b", { timeRange: { from: "now", to: "now-1h" } }),
  ]);
  const events: PollerEvent[] = [];
  const stop = getPoller(dashboardId(), 1, "ws", spec, {}, executor).subscribe((e) =>
    events.push(e),
  );
  await settle();
  assert.equal(count("a"), 1);
  assert.equal(count("b"), 0);
  const error = events.find((e) => e.type === "panel-error" && e.panelId === "b");
  assert.equal(error?.type === "panel-error" ? error.kind : undefined, "validation");
  assert.ok(
    events.some((e) => e.type === "tick"),
    "the cycle still completes",
  );
  stop();
});

test("a proposed edit that changes a panel's window or cadence says so", () => {
  const before = Panel.parse(panel("a"));
  const diff = diffPanels(before, {
    ...before,
    timeRange: { from: "now-5m", to: "now" },
    refreshIntervalMs: 5_000,
  });
  const changed = diff.fields.filter((f) => f.changed);
  assert.deepEqual(
    changed.map((f) => [f.key, f.before, f.after]),
    [
      ["timeRange", "the dashboard's", "now-5m → now"],
      ["refreshIntervalMs", "the dashboard's", "every 5s"],
    ],
  );
});
