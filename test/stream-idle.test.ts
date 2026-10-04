import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createHiddenWatch,
  createIdleWatch,
  DEMO_IDLE_PAUSE_MS,
  HIDDEN_STREAM_GRACE_MS,
  type Timers,
} from "@/lib/stream-idle";

/** A manual clock: `advance` runs every timer that falls due, in order. */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: Timers = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { at: now + ms, fn });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      pending.delete(id as unknown as number);
    },
  };
  function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...pending.entries()]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      pending.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  }
  return { timers, advance, pendingCount: () => pending.size };
}

test("an idle watch fires once after the full idle period", () => {
  const clock = fakeTimers();
  let fired = 0;
  createIdleWatch(1_000, () => fired++, clock.timers);
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
  clock.advance(10_000);
  assert.equal(fired, 1, "fires once, not on every period");
  assert.equal(clock.pendingCount(), 0);
});

test("activity pushes the idle deadline back from the last event", () => {
  const clock = fakeTimers();
  let fired = 0;
  const watch = createIdleWatch(1_000, () => fired++, clock.timers);
  clock.advance(600);
  watch.activity();
  clock.advance(600);
  assert.equal(fired, 0, "1.2s since start, 0.6s since activity");
  watch.activity();
  clock.advance(999);
  assert.equal(fired, 0);
  clock.advance(1);
  assert.equal(fired, 1);
});

test("activity keeps at most one timer pending", () => {
  const clock = fakeTimers();
  const watch = createIdleWatch(1_000, () => {}, clock.timers);
  for (let i = 0; i < 100; i++) {
    clock.advance(5);
    watch.activity();
  }
  assert.equal(clock.pendingCount(), 1);
});

test("a disposed idle watch never fires", () => {
  const clock = fakeTimers();
  let fired = 0;
  const watch = createIdleWatch(1_000, () => fired++, clock.timers);
  clock.advance(500);
  watch.dispose();
  clock.advance(5_000);
  assert.equal(fired, 0);
  assert.equal(clock.pendingCount(), 0);
});

test("a hidden page suspends only after the grace period", () => {
  const clock = fakeTimers();
  const changes: boolean[] = [];
  const watch = createHiddenWatch(1_000, (s) => changes.push(s), clock.timers);
  watch.visibility(false);
  assert.deepEqual(changes, [], "visible at mount reports nothing");
  watch.visibility(true);
  clock.advance(999);
  assert.deepEqual(changes, []);
  clock.advance(1);
  assert.deepEqual(changes, [true]);
  watch.visibility(false);
  assert.deepEqual(changes, [true, false], "shown again resumes immediately");
});

test("a quick look at another tab costs nothing", () => {
  const clock = fakeTimers();
  const changes: boolean[] = [];
  const watch = createHiddenWatch(1_000, (s) => changes.push(s), clock.timers);
  watch.visibility(true);
  clock.advance(500);
  watch.visibility(false);
  clock.advance(5_000);
  assert.deepEqual(changes, []);
  assert.equal(clock.pendingCount(), 0);
});

test("repeated hidden events do not restart the grace period", () => {
  const clock = fakeTimers();
  const changes: boolean[] = [];
  const watch = createHiddenWatch(1_000, (s) => changes.push(s), clock.timers);
  watch.visibility(true);
  clock.advance(600);
  watch.visibility(true);
  clock.advance(400);
  assert.deepEqual(changes, [true]);
  watch.visibility(true);
  assert.deepEqual(changes, [true], "already suspended: no repeat report");
});

test("a disposed hidden watch reports nothing", () => {
  const clock = fakeTimers();
  const changes: boolean[] = [];
  const watch = createHiddenWatch(1_000, (s) => changes.push(s), clock.timers);
  watch.visibility(true);
  watch.dispose();
  clock.advance(5_000);
  assert.deepEqual(changes, []);
});

test("the demo pauses well before its container would sleep anyway", () => {
  // The container's sleepAfter is 30 minutes; pausing at or past it would
  // double the time a forgotten tab keeps it awake.
  assert.ok(DEMO_IDLE_PAUSE_MS < 30 * 60_000);
  assert.ok(HIDDEN_STREAM_GRACE_MS < DEMO_IDLE_PAUSE_MS);
});
