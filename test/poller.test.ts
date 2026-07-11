import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeDelta,
  getPoller,
  invalidatePoller,
  activePollerCount,
  type PanelExecutor,
} from "@/lib/poller/registry";
import type { Dashboard } from "@/lib/ir";

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
  const rows = [{ ts: "2024-01-01 00:00:01" }, { ts: "2024-01-01 00:00:03" }, { ts: "2024-01-01 00:00:02" }];
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
  const a = getPoller("dash-shared", 1, spec(), noopExecutor);
  const b = getPoller("dash-shared", 1, spec(), noopExecutor);
  assert.equal(a, b);
  invalidatePoller("dash-shared");
});

test("getPoller replaces the poller when a higher version is requested", () => {
  const v1 = getPoller("dash-ver", 1, spec(), noopExecutor);
  const v1again = getPoller("dash-ver", 1, spec(), noopExecutor);
  assert.equal(v1, v1again, "same/lower version keeps existing poller");
  const v2 = getPoller("dash-ver", 2, spec(), noopExecutor);
  assert.notEqual(v1, v2, "higher version replaces the poller");
  assert.equal(v2.version, 2);
  invalidatePoller("dash-ver");
});

test("subscribe ref-counts and the last unsubscribe stops the poller", () => {
  const before = activePollerCount();
  const poller = getPoller("dash-refcount", 1, spec(), noopExecutor);
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
  const poller = getPoller("dash-onetick", 1, spec(), executor);
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
