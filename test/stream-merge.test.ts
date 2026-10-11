import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePanelRows } from "@/lib/stream-merge";
import { applyPollerEvents, markStale, type PanelStates } from "@/lib/panel-state";
import { fitToWindow } from "@/lib/stream-merge";
import { readTruncation } from "@/lib/truncation";
import type { PollerEvent } from "@/lib/poller/registry";

/**
 * Landing a stream frame on a panel's window: replace, append, and the
 * `since` overlap that keeps a filling bucket current (#43).
 */

type PanelEvent = Extract<PollerEvent, { type: "panel" }>;

const frame = (patch: Partial<PanelEvent>): PanelEvent => ({
  type: "panel",
  panelId: "p",
  mode: "append",
  columns: ["minute", "route", "n"],
  rows: [],
  ...patch,
});

const m = (n: number) => `2026-10-04T10:0${n}:00.000Z`;
const prev = {
  columns: ["minute", "route", "n"],
  rows: [
    { minute: m(1), route: "/a", n: 5 },
    { minute: m(1), route: "/b", n: 3 },
    { minute: m(2), route: "/a", n: 1 },
    { minute: m(2), route: "/b", n: 1 },
  ],
};

test("an append from `since` replaces every series' rows in the filling bucket", () => {
  const next = mergePanelRows(
    prev,
    frame({
      since: m(2),
      timeField: "minute",
      rows: [
        { minute: m(2), route: "/a", n: 4 },
        { minute: m(2), route: "/b", n: 2 },
        { minute: m(3), route: "/a", n: 1 },
      ],
    }),
    720,
  );
  assert.deepEqual(next.rows, [
    { minute: m(1), route: "/a", n: 5 },
    { minute: m(1), route: "/b", n: 3 },
    { minute: m(2), route: "/a", n: 4 },
    { minute: m(2), route: "/b", n: 2 },
    { minute: m(3), route: "/a", n: 1 },
  ]);
});

test("a series that vanished from the bucket goes with it", () => {
  const next = mergePanelRows(
    prev,
    frame({
      since: m(2),
      timeField: "minute",
      rows: [{ minute: m(2), route: "/a", n: 2 }],
    }),
    720,
  );
  assert.deepEqual(
    next.rows.map((r) => [r.minute, r.route]),
    [
      [m(1), "/a"],
      [m(1), "/b"],
      [m(2), "/a"],
    ],
  );
});

test("an append without `since` adds, a replace swaps, and the window stays bounded", () => {
  const added = mergePanelRows(
    prev,
    frame({ rows: [{ minute: m(3), route: "/a", n: 9 }] }),
    3,
  );
  assert.equal(added.rows.length, 3);
  assert.deepEqual(added.rows.at(-1), { minute: m(3), route: "/a", n: 9 });

  const swapped = mergePanelRows(prev, frame({ mode: "replace", rows: [{ n: 1 }] }), 720);
  assert.deepEqual(swapped.rows, [{ n: 1 }]);

  const first = mergePanelRows(
    undefined,
    frame({ since: m(2), timeField: "minute", rows: [{ n: 2 }] }),
    720,
  );
  assert.deepEqual(first.rows, [{ n: 2 }]);
  // Columns survive a frame that carries none.
  assert.deepEqual(
    mergePanelRows(prev, frame({ columns: [] }), 720).columns,
    prev.columns,
  );
});

/**
 * One point budget (#486): a panel keeps the newest `maxWindowPoints` rows
 * whether they came whole or as an append, and says so when that dropped
 * any, so a chart never passes as the whole result when it is not.
 */
test("the window keeps the newest rows and says when it cut, replace or append", () => {
  const rows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ minute: m(i % 10), i }));
  const replaced = mergePanelRows(
    undefined,
    frame({ mode: "replace", rows: rows(5) }),
    3,
  );
  assert.deepEqual(
    replaced.rows.map((r) => r.i),
    [2, 3, 4],
  );
  assert.deepEqual(replaced.truncated, { stage: "window", kept: 3, total: 5 });

  // A whole result under the budget is shown as sent, with no badge.
  const whole = mergePanelRows(undefined, frame({ mode: "replace", rows: rows(3) }), 3);
  assert.equal(whole.rows.length, 3);
  assert.equal(whole.truncated, undefined);

  // An append that overflows rolls the oldest off, keeping the last count.
  const rolled = mergePanelRows(replaced, frame({ rows: [{ minute: m(9), i: 9 }] }), 3);
  assert.deepEqual(
    rolled.rows.map((r) => r.i),
    [3, 4, 9],
  );
  assert.deepEqual(rolled.truncated, { stage: "window", kept: 3, total: 5 });
});

test("a cut the server made rides through, and the browser's own cut is later", () => {
  const server = { stage: "rows", kept: 4, total: 9 } as const;
  const sent = Array.from({ length: 4 }, (_, i) => ({ minute: m(i), i }));
  const shown = mergePanelRows(
    undefined,
    frame({ mode: "replace", rows: sent, truncated: server }),
    10,
  );
  assert.deepEqual(shown.truncated, server);
  // Over the window too: the badge names the window, with the server's total.
  assert.deepEqual(
    fitToWindow({ columns: [], rows: sent, truncated: server }, 2).truncated,
    {
      stage: "window",
      kept: 2,
      total: 9,
    },
  );
  // Without a time field the server cannot count: the total stays unknown.
  assert.deepEqual(
    fitToWindow({ columns: [], rows: sent, truncated: { stage: "rows", kept: 4 } }, 2)
      .truncated,
    { stage: "window", kept: 2 },
  );
});

test("a truncation read off the wire is held to its shape", () => {
  assert.deepEqual(readTruncation({ stage: "points", kept: 1000, total: 5761 }), {
    stage: "points",
    kept: 1000,
    total: 5761,
  });
  for (const bad of [
    null,
    "rows",
    { stage: "everything", kept: 1 },
    { stage: "rows", kept: -1 },
    { stage: "rows", kept: Number.NaN },
    { stage: "rows" },
  ]) {
    assert.equal(readTruncation(bad), undefined, JSON.stringify(bad));
  }
  // A total that is not more than what was kept is no total.
  assert.deepEqual(readTruncation({ stage: "rows", kept: 5, total: 5 }), {
    stage: "rows",
    kept: 5,
  });
});

/**
 * A tick's frames land in one step (#485), and a panel no frame names keeps
 * its state object: that identity is what lets a memoized `PanelView` skip
 * it, so one changed panel renders one panel.
 */
test("a batch is one new state, and an untouched panel keeps its own", () => {
  const states: PanelStates = {
    a: { data: prev, status: "live", updatedAt: 1 },
    b: { data: prev, status: "live", updatedAt: 1 },
    c: { data: prev, status: "error", updatedAt: 1 },
  };
  const next = applyPollerEvents(
    states,
    [
      frame({
        panelId: "a",
        mode: "replace",
        rows: [{ minute: m(5), route: "/a", n: 1 }],
      }),
      { type: "panel-error", panelId: "c", error: "boom", kind: "statement" },
      frame({ panelId: "a", rows: [{ minute: m(6), route: "/a", n: 2 }] }),
      { type: "tick", at: 2 },
    ],
    100,
    2,
  );
  assert.notEqual(next, states);
  assert.equal(next.b, states.b, "a panel no frame names keeps its state object");
  // Later frames build on earlier ones in the same batch.
  assert.deepEqual(
    next.a.data.rows.map((r) => r.minute),
    [m(5), m(6)],
  );
  assert.equal(next.a.updatedAt, 2);
  assert.equal(next.c.status, "error");
  assert.equal(states.a.data, prev, "the previous state is not mutated");
});

test("a batch about no panel, or staleness with nothing live, changes nothing", () => {
  const states: PanelStates = { a: { data: prev, status: "error" } };
  assert.equal(applyPollerEvents(states, [{ type: "tick", at: 1 }], 100, 1), states);
  assert.equal(applyPollerEvents(states, [], 100, 1), states);
  assert.equal(markStale(states), states);
  const live: PanelStates = { ...states, b: { data: prev, status: "live" } };
  const stale = markStale(live);
  assert.equal(stale.b.status, "stale");
  assert.equal(stale.a, live.a);
});

test("an append drops what the server's whole result no longer holds, without a badge", () => {
  // #530: a window holding fewer rows than the budget kept stale ones until
  // the count filled.
  const next = mergePanelRows(
    prev,
    frame({
      since: m(3),
      oldest: m(2),
      timeField: "minute",
      rows: [{ minute: m(3), route: "/a", n: 7 }],
    }),
    100,
  );
  assert.deepEqual(
    next.rows.map((r) => r.minute),
    [m(2), m(2), m(3)],
  );
  assert.equal(next.truncated, undefined);
});
