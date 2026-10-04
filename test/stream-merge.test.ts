import { test } from "node:test";
import assert from "node:assert/strict";
import { mergePanelRows } from "@/lib/stream-merge";
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
