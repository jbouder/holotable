import { test } from "node:test";
import assert from "node:assert/strict";
import { Dashboard, type Panel } from "@/lib/ir";
import { overlaps } from "@/lib/grid-layout";
import {
  canMove,
  copyTitle,
  duplicatePanel,
  movePanel,
  type PanelMove,
  reorderPanels,
  uniquePanelId,
} from "@/lib/panel-list";

function panel(id: string, layout = { x: 0, y: 0, w: 6, h: 4 }): Panel {
  return {
    id,
    title: id,
    viz: "line",
    query: { sourceId: "src-1", sql: `SELECT 1 AS ${id}`, timeField: undefined },
    layout,
  };
}

const ids = (panels: Panel[]) => panels.map((p) => p.id);

/* -------------------------------------------------------------------------- */
/* Moving through the order                                                   */
/* -------------------------------------------------------------------------- */

const three = [panel("a"), panel("b"), panel("c")];

test("each move sends the panel where it says", () => {
  const cases: [string, PanelMove, string[]][] = [
    ["b", "up", ["b", "a", "c"]],
    ["b", "down", ["a", "c", "b"]],
    ["c", "top", ["c", "a", "b"]],
    ["a", "bottom", ["b", "c", "a"]],
  ];
  for (const [id, move, expected] of cases) {
    assert.deepEqual(ids(movePanel(three, id, move)), expected, `${id} ${move}`);
  }
});

test("a move off the end of the list is a no-op, not a wrap", () => {
  assert.deepEqual(ids(movePanel(three, "a", "up")), ["a", "b", "c"]);
  assert.deepEqual(ids(movePanel(three, "c", "down")), ["a", "b", "c"]);
  assert.equal(movePanel(three, "a", "top"), three);
});

test("canMove agrees with what a move would do", () => {
  for (const move of ["up", "down", "top", "bottom"] as PanelMove[]) {
    for (const id of ["a", "b", "c"]) {
      const changed = ids(movePanel(three, id, move)).join() !== ids(three).join();
      assert.equal(canMove(three, id, move), changed, `${id} ${move}`);
    }
  }
});

test("an unknown id changes nothing", () => {
  assert.equal(movePanel(three, "gone", "top"), three);
  assert.equal(reorderPanels(three, "gone", 0), three);
  assert.equal(canMove(three, "gone", "up"), false);
  assert.equal(duplicatePanel(three, "gone"), null);
});

test("a drop slides the rest along and clamps past the ends", () => {
  assert.deepEqual(ids(reorderPanels(three, "a", 2)), ["b", "c", "a"]);
  assert.deepEqual(ids(reorderPanels(three, "c", 0)), ["c", "a", "b"]);
  assert.deepEqual(ids(reorderPanels(three, "a", 99)), ["b", "c", "a"]);
  assert.deepEqual(ids(reorderPanels(three, "c", -5)), ["c", "a", "b"]);
});

/**
 * The invariant that makes reordering safe on a hand-positioned dashboard: the
 * array order changes and nothing else does.
 */
test("reordering leaves every layout exactly as it was", () => {
  const positioned = [
    panel("a", { x: 0, y: 0, w: 4, h: 3 }),
    panel("b", { x: 4, y: 0, w: 8, h: 6 }),
    panel("c", { x: 0, y: 6, w: 12, h: 5 }),
  ];
  const moved = movePanel(positioned, "c", "top");
  for (const p of positioned) {
    assert.deepEqual(moved.find((m) => m.id === p.id)?.layout, p.layout);
  }
});

/* -------------------------------------------------------------------------- */
/* Duplicating                                                                */
/* -------------------------------------------------------------------------- */

test("the copy lands directly after the original, selected and renamed", () => {
  const out = duplicatePanel(three, "a");
  assert.ok(out);
  assert.deepEqual(ids(out.panels), ["a", "a-copy", "b", "c"]);
  assert.equal(out.id, "a-copy");
  assert.equal(out.panels[1].title, "a (copy)");
});

test("the copy renders identically: same query, viz and size", () => {
  const original = {
    ...panel("a", { x: 3, y: 2, w: 4, h: 7 }),
    viz: "bar" as const,
    format: "bytes" as const,
    description: "what it counts",
  };
  const out = duplicatePanel([original], "a");
  assert.ok(out);
  const copy = out.panels[1];
  assert.deepEqual(copy.query, original.query);
  assert.equal(copy.viz, original.viz);
  assert.equal(copy.format, original.format);
  assert.equal(copy.description, original.description);
  assert.equal(copy.layout.w, original.layout.w);
  assert.equal(copy.layout.h, original.layout.h);
  assert.equal(copy.layout.x, original.layout.x);
  // Directly below, which is the one thing it cannot share.
  assert.equal(copy.layout.y, original.layout.y + original.layout.h);
});

test("the copy pushes what it landed on out of the way instead of hiding it", () => {
  const stacked = [
    panel("a", { x: 0, y: 0, w: 6, h: 4 }),
    panel("b", { x: 0, y: 4, w: 6, h: 4 }),
  ];
  const out = duplicatePanel(stacked, "a");
  assert.ok(out);
  for (const a of out.panels) {
    for (const b of out.panels) {
      if (a.id !== b.id) assert.ok(!overlaps(a.layout, b.layout), `${a.id} / ${b.id}`);
    }
  }
});

test("duplicating twice does not collide with the first copy", () => {
  const once = duplicatePanel(three, "a");
  assert.ok(once);
  const twice = duplicatePanel(once.panels, "a");
  assert.ok(twice);
  assert.equal(twice.id, "a-copy-2");
  assert.equal(new Set(ids(twice.panels)).size, twice.panels.length);
});

test("a duplicated dashboard still satisfies the IR's unique-id rule", () => {
  const out = duplicatePanel(three, "b");
  assert.ok(out);
  const parsed = Dashboard.safeParse({
    title: "d",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: out.panels,
  });
  assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
});

/* -------------------------------------------------------------------------- */
/* The bounds the IR puts on ids and titles                                   */
/* -------------------------------------------------------------------------- */

test("an id at the limit makes room for its suffix rather than colliding", () => {
  const long = "p".repeat(64);
  const out = duplicatePanel([panel(long)], long);
  assert.ok(out);
  assert.ok(out.id.length <= 64);
  assert.notEqual(out.id, long);
});

test("uniquePanelId keeps trying until it finds a free one", () => {
  const taken = [panel("x"), panel("x-2"), panel("x-3")];
  assert.equal(uniquePanelId(taken, "x"), "x-4");
  assert.equal(uniquePanelId(taken, "y"), "y");
});

test("a title at the limit stays inside it", () => {
  const title = copyTitle("t".repeat(200));
  assert.equal(title.length, 200);
  assert.ok(title.endsWith(" (copy)"));
});
