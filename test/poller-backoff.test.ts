import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { config } from "@/lib/config";
import { OPAQUE_MESSAGE } from "@/lib/errors";
import type { Dashboard } from "@/lib/ir";
import { createLogger, setLogger } from "@/lib/log";
import {
  type BackoffPolicy,
  backoffDelay,
  canRetryNow,
  isDue,
  recordFailure,
} from "@/lib/poller/backoff";
import {
  DashboardPoller,
  getPoller,
  invalidatePoller,
  type PanelExecutor,
  type PollerEvent,
  retryPanel,
} from "@/lib/poller/registry";
import { QueryExecutionError } from "@/lib/timescaledb/client";

/*
 * Poller backoff (#44): the policy as arithmetic, then the poller on a mocked
 * clock, so every transition is at an exact time instead of a sleep.
 */

const POLICY: BackoffPolicy = { threshold: 3, maxMs: 300_000 };
const INTERVAL = 15_000;

/* -------------------------------------------------------------------------- */
/* The policy                                                                 */
/* -------------------------------------------------------------------------- */

test("under the threshold a failure changes nothing", () => {
  assert.equal(backoffDelay(1, INTERVAL, POLICY), null);
  assert.equal(backoffDelay(2, INTERVAL, POLICY), null);
});

test("from the threshold the wait doubles up to the ceiling", () => {
  const waits = [3, 4, 5, 6, 7, 8, 1_000].map((n) => backoffDelay(n, INTERVAL, POLICY));
  assert.deepEqual(waits, [30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
});

test("the wait is never shorter than the dashboard's own interval", () => {
  // A ten-minute dashboard is not sped up by failing.
  assert.equal(backoffDelay(3, 600_000, POLICY), 600_000);
});

test("a failure under the threshold leaves the panel due on the next tick", () => {
  const once = recordFailure(undefined, 1_000, 1_200, INTERVAL, POLICY);
  assert.deepEqual(once, { failures: 1, lastAttemptAt: 1_000, retryAt: null });
  assert.equal(isDue(once, 1_201), true);
});

test("a failure at the threshold sets retryAt from when the attempt finished", () => {
  const two = { failures: 2, lastAttemptAt: 0, retryAt: null };
  const three = recordFailure(two, 10_000, 12_000, INTERVAL, POLICY);
  assert.deepEqual(three, { failures: 3, lastAttemptAt: 10_000, retryAt: 42_000 });
  assert.equal(isDue(three, 41_999), false);
  assert.equal(isDue(three, 42_000), true);
  assert.equal(isDue(undefined, 0), true, "a healthy panel is always due");
});

test("a manual retry needs a panel that is backing off, and not too soon", () => {
  const backingOff = { failures: 3, lastAttemptAt: 10_000, retryAt: 40_000 };
  assert.equal(canRetryNow(backingOff, 11_999, 2_000), false);
  assert.equal(canRetryNow(backingOff, 12_000, 2_000), true);
  assert.equal(canRetryNow(undefined, 50_000, 2_000), false, "healthy");
  assert.equal(
    canRetryNow({ failures: 1, lastAttemptAt: 0, retryAt: null }, 50_000, 2_000),
    false,
    "under the threshold: the next tick runs it",
  );
});

/* -------------------------------------------------------------------------- */
/* The poller, on a mocked clock                                              */
/* -------------------------------------------------------------------------- */

function spec(): Dashboard {
  return {
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: INTERVAL,
    panels: [
      {
        id: "p1",
        title: "p1",
        viz: "stat",
        query: { sourceId: "s1", sql: "SELECT 1 AS v" },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  };
}

/** An executor that fails while `failing` says so, and counts its calls. */
function flaky() {
  const state = { calls: 0, failing: true };
  const executor: PanelExecutor = async (panel) => {
    state.calls++;
    if (state.failing) throw new Error("connect ECONNREFUSED 10.0.0.1:5432");
    return [
      { type: "panel", panelId: panel.id, mode: "replace", columns: ["v"], rows: [] },
    ];
  };
  return { state, executor };
}

/** Let the tick's promise chain run to the end. */
async function settle() {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

/** Advance the mocked clock to the next tick and let it finish. */
async function nextTick(ms = INTERVAL) {
  mock.timers.tick(ms);
  await settle();
}

function subscribe(poller: DashboardPoller) {
  const events: PollerEvent[] = [];
  const stop = poller.subscribe((e) => {
    if (e.type !== "tick") events.push(e);
  });
  return { events, stop, last: () => events.at(-1) };
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  setLogger(createLogger({ level: "silent" }));
});

afterEach(() => {
  mock.timers.reset();
  setLogger(createLogger());
});

test("a panel that keeps failing stops running every tick, and waits longer each time", async () => {
  const { state, executor } = flaky();
  const poller = new DashboardPoller("d-open", 1, "ws", spec(), {}, executor, POLICY);
  const sub = subscribe(poller);
  await settle(); // t=0: failure 1

  assert.equal(sub.last()?.type, "panel-error");
  await nextTick(); // t=15s: failure 2
  assert.equal(sub.last()?.type, "panel-error");
  await nextTick(); // t=30s: failure 3, opens until 60s
  assert.deepEqual(sub.last(), {
    type: "panel-degraded",
    panelId: "p1",
    error: OPAQUE_MESSAGE,
    kind: "infrastructure",
    failures: 3,
    retryAt: 60_000,
  });
  assert.equal(state.calls, 3);

  await nextTick(); // t=45s: sits out
  assert.equal(state.calls, 3, "not executed while backing off");
  await nextTick(); // t=60s: due, fails again, now until 120s
  assert.equal(state.calls, 4);
  const fourth = sub.last();
  assert.ok(fourth?.type === "panel-degraded");
  assert.equal(fourth.failures, 4);
  assert.equal(fourth.retryAt, 120_000);

  for (let i = 0; i < 3; i++) await nextTick(); // t=75, 90, 105s
  assert.equal(state.calls, 4);
  await nextTick(); // t=120s
  assert.equal(state.calls, 5);
  sub.stop();
});

test("one success puts the panel back on its normal cadence at once", async () => {
  const { state, executor } = flaky();
  const poller = new DashboardPoller("d-reset", 1, "ws", spec(), {}, executor, POLICY);
  const sub = subscribe(poller);
  await settle();
  await nextTick();
  await nextTick(); // degraded until 60s
  state.failing = false;

  await nextTick(); // t=45s: still sitting out
  assert.equal(state.calls, 3);
  await nextTick(); // t=60s: the trial succeeds
  assert.equal(sub.last()?.type, "panel");
  await nextTick(); // t=75s: running every tick again
  await nextTick(); // t=90s
  assert.equal(state.calls, 6);

  // And the count starts over: one new failure is a plain error again.
  state.failing = true;
  await nextTick();
  assert.equal(sub.last()?.type, "panel-error");
  sub.stop();
});

test("a refusal that never reached the source is not counted", async () => {
  let calls = 0;
  const refusing: PanelExecutor = async (panel) => {
    calls++;
    return [{ type: "panel-error", panelId: panel.id, error: "no", kind: "statement" }];
  };
  const poller = new DashboardPoller("d-refuse", 1, "ws", spec(), {}, refusing, POLICY);
  const sub = subscribe(poller);
  await settle();
  for (let i = 0; i < 5; i++) await nextTick();
  assert.equal(calls, 6);
  assert.ok(sub.events.every((e) => e.type === "panel-error"));
  sub.stop();
});

test("a statement failure keeps its real message while degraded", async () => {
  const failing: PanelExecutor = async () => {
    throw new QueryExecutionError("canceling statement due to statement timeout");
  };
  const poller = new DashboardPoller("d-stmt", 1, "ws", spec(), {}, failing, POLICY);
  const sub = subscribe(poller);
  await settle();
  await nextTick();
  await nextTick();
  const degraded = sub.last();
  assert.ok(degraded?.type === "panel-degraded");
  assert.equal(degraded.kind, "statement");
  assert.equal(degraded.error, "canceling statement due to statement timeout");
  sub.stop();
});

test("a viewer who joins a degraded panel is told so at once", async () => {
  const { executor } = flaky();
  const poller = new DashboardPoller("d-join", 1, "ws", spec(), {}, executor, POLICY);
  const first = subscribe(poller);
  await settle();
  await nextTick();
  await nextTick();

  const joiner = subscribe(poller);
  assert.equal(joiner.events[0]?.type, "panel-degraded");
  first.stop();
  joiner.stop();
});

test("retry now runs a degraded panel at once, but not sooner than the floor", async () => {
  const { state, executor } = flaky();
  const poller = new DashboardPoller("d-retry", 1, "ws", spec(), {}, executor, POLICY);
  const sub = subscribe(poller);
  await settle();
  assert.equal(poller.retryPanel("p1"), false, "under the threshold");
  await nextTick();
  await nextTick(); // t=30s: degraded until 60s, last attempt at 30s

  assert.equal(poller.retryPanel("p1"), false, "within MIN_REFRESH_INTERVAL_MS");
  await nextTick(config.minRefreshIntervalMs);
  state.failing = false;
  assert.equal(poller.retryPanel("p1"), true);
  await settle();
  assert.equal(state.calls, 4);
  assert.equal(sub.last()?.type, "panel", "the result goes out on the stream");
  assert.equal(poller.retryPanel("p1"), false, "healthy again");
  assert.equal(poller.retryPanel("nope"), false, "no such panel");
  sub.stop();
});

test("a failed retry counts, and lengthens the wait", async () => {
  const { executor } = flaky();
  const poller = new DashboardPoller(
    "d-retry-fail",
    1,
    "ws",
    spec(),
    {},
    executor,
    POLICY,
  );
  const sub = subscribe(poller);
  await settle();
  await nextTick();
  await nextTick(); // t=30s
  await nextTick(5_000); // t=35s
  assert.equal(poller.retryPanel("p1"), true);
  await settle();
  const after = sub.last();
  assert.ok(after?.type === "panel-degraded");
  assert.equal(after.failures, 4);
  assert.equal(after.retryAt, 35_000 + 60_000);
  sub.stop();
});

test("a retry never overlaps an execution already running", async () => {
  let release: (() => void) | undefined;
  let calls = 0;
  let mode: "fail" | "hang" = "fail";
  const executor: PanelExecutor = async () => {
    calls++;
    if (mode === "fail") throw new Error("down");
    await new Promise<void>((r) => {
      release = r;
    });
    throw new Error("still down");
  };
  const poller = new DashboardPoller("d-overlap", 1, "ws", spec(), {}, executor, POLICY);
  const sub = subscribe(poller);
  await settle();
  await nextTick();
  await nextTick(); // t=30s, degraded until 60s
  mode = "hang";
  await nextTick(30_000); // t=60s: the trial starts and hangs
  assert.equal(calls, 4);
  assert.equal(poller.retryPanel("p1"), false);
  release?.();
  await settle();
  assert.equal(calls, 4);
  sub.stop();
});

test("retryPanel reaches the dashboard's running pollers only", async () => {
  const { state, executor } = flaky();
  const poller = getPoller("d-registry", 1, "ws", spec(), {}, executor);
  const sub = subscribe(poller);
  await settle();
  for (let i = 1; i < config.pollerFailureThreshold; i++) await nextTick();
  await nextTick(config.minRefreshIntervalMs);
  assert.equal(retryPanel("some-other-dashboard", "p1"), 0);
  assert.equal(retryPanel("d-registry", "p1"), 1);
  await settle();
  assert.equal(state.calls, config.pollerFailureThreshold + 1);
  sub.stop();
  invalidatePoller("d-registry");
  assert.equal(retryPanel("d-registry", "p1"), 0, "a stopped poller runs nothing");
});
