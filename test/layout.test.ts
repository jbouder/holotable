import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { autoLayoutPanels, DEFAULT_COLUMNS } from "@/lib/layout";

function panel(id: string, h = 4): Panel {
  return {
    id,
    title: id,
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT 1 AS v" },
    layout: { x: 0, y: 0, w: 12, h },
  };
}

test("defaults to two panels side by side (w=6)", () => {
  const out = autoLayoutPanels([panel("a"), panel("b")], DEFAULT_COLUMNS);
  assert.deepEqual(
    out.map((p) => ({ x: p.layout.x, y: p.layout.y, w: p.layout.w })),
    [
      { x: 0, y: 0, w: 6 },
      { x: 6, y: 0, w: 6 },
    ],
  );
});

test("wraps to the next row after the column count", () => {
  const out = autoLayoutPanels(
    [panel("a"), panel("b"), panel("c")],
    2,
  );
  // third panel starts a new row below the first row's height
  assert.deepEqual(out[2].layout, { x: 0, y: 4, w: 6, h: 4 });
});

test("row y accounts for the tallest panel in the prior row", () => {
  const out = autoLayoutPanels([panel("a", 6), panel("b", 3), panel("c", 2)], 2);
  assert.equal(out[2].layout.y, 6); // max(6,3) of the first row
});

test("preserves order and each panel's height; never mutates input", () => {
  const input = [panel("a", 3), panel("b", 5)];
  const snapshot = JSON.parse(JSON.stringify(input));
  const out = autoLayoutPanels(input, 3);
  assert.deepEqual(out.map((p) => p.id), ["a", "b"]);
  assert.equal(out[0].layout.w, 4); // 12/3
  assert.equal(out[0].layout.h, 3);
  assert.equal(out[1].layout.h, 5);
  assert.deepEqual(input, snapshot);
});

test("clamps column count into 1..12 and keeps width >= 1", () => {
  assert.equal(autoLayoutPanels([panel("a")], 0)[0].layout.w, 12);
  assert.equal(autoLayoutPanels([panel("a")], 99)[0].layout.w, 1);
});
