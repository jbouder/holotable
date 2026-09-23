import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel, PanelLayout } from "@/lib/ir";
import { GRID_COLUMNS } from "@/lib/layout";
import {
  BREAKPOINT_COLUMNS,
  gridArea,
  reflowLayouts,
  rowHeightAt,
} from "@/lib/responsive-grid";

function panel(id: string, layout: PanelLayout): Panel {
  return {
    id,
    title: id,
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT 1 AS v" },
    layout,
  };
}

/** Do any two of these rectangles share a cell? */
function anyOverlap(layouts: PanelLayout[]): boolean {
  return layouts.some((a, i) =>
    layouts.some(
      (b, j) =>
        i !== j &&
        a.x < b.x + b.w &&
        b.x < a.x + a.w &&
        a.y < b.y + b.h &&
        b.y < a.y + a.h,
    ),
  );
}

test("the 12-column arrangement is returned untouched", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 7, h: 4 }),
    panel("b", { x: 7, y: 0, w: 5, h: 2 }),
  ];
  const out = reflowLayouts(panels, GRID_COLUMNS);
  assert.deepEqual(out, [panels[0].layout, panels[1].layout]);
  // Identity, not a copy: nothing re-derives a layout on the screen it was
  // authored on.
  assert.equal(out[0], panels[0].layout);
});

test("mobile stacks every panel one per row, in reading order", () => {
  const panels = [
    // Deliberately out of reading order in the array.
    panel("bottom", { x: 0, y: 4, w: 12, h: 3 }),
    panel("right", { x: 6, y: 0, w: 6, h: 4 }),
    panel("left", { x: 0, y: 0, w: 6, h: 4 }),
  ];
  const out = reflowLayouts(panels, BREAKPOINT_COLUMNS.sm);

  // Returned in input order...
  assert.deepEqual(
    out.map((l) => l.w),
    [1, 1, 1],
  );
  // ...but positioned in reading order: left, right, then bottom.
  const byId = new Map(panels.map((p, i) => [p.id, out[i]]));
  assert.equal(byId.get("left")?.y, 0);
  assert.equal(byId.get("right")?.y, 4);
  assert.equal(byId.get("bottom")?.y, 8);
  assert.ok(out.every((l) => l.x === 0));
});

test("tablet halves each width and keeps panels side by side", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 6, h: 4 }),
    panel("b", { x: 6, y: 0, w: 6, h: 4 }),
    panel("c", { x: 0, y: 4, w: 12, h: 3 }),
  ];
  const out = reflowLayouts(panels, BREAKPOINT_COLUMNS.md);
  assert.deepEqual(out, [
    { x: 0, y: 0, w: 3, h: 4 },
    { x: 3, y: 0, w: 3, h: 4 },
    { x: 0, y: 4, w: 6, h: 3 },
  ]);
});

test("heights are preserved and rows clear the tallest panel", () => {
  const panels = [
    panel("tall", { x: 0, y: 0, w: 6, h: 6 }),
    panel("short", { x: 6, y: 0, w: 6, h: 2 }),
    panel("next", { x: 0, y: 6, w: 12, h: 3 }),
  ];
  const out = reflowLayouts(panels, BREAKPOINT_COLUMNS.md);
  assert.deepEqual(
    out.map((l) => l.h),
    [6, 2, 3],
  );
  // The third panel clears the 6-row panel above it, not the 2-row one.
  assert.equal(out[2].y, 6);
});

test("a four-up row wraps rather than overflowing the tablet grid", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 3, h: 4 }),
    panel("b", { x: 3, y: 0, w: 3, h: 4 }),
    panel("c", { x: 6, y: 0, w: 3, h: 4 }),
    panel("d", { x: 9, y: 0, w: 3, h: 4 }),
  ];
  const out = reflowLayouts(panels, BREAKPOINT_COLUMNS.md);
  // 3/12 rounds to 2/6, so three fit per row and the fourth wraps.
  assert.deepEqual(out, [
    { x: 0, y: 0, w: 2, h: 4 },
    { x: 2, y: 0, w: 2, h: 4 },
    { x: 4, y: 0, w: 2, h: 4 },
    { x: 0, y: 4, w: 2, h: 4 },
  ]);
});

test("no re-flow ever overlaps, however narrow the panels", () => {
  // Twelve one-column panels is the case that defeats rescaling coordinates:
  // every one of them rounds onto the same handful of cells.
  const panels = Array.from({ length: 12 }, (_, i) =>
    panel(`p${i}`, { x: i, y: 0, w: 1, h: 2 }),
  );
  for (const columns of [1, 2, 3, 4, 6]) {
    const out = reflowLayouts(panels, columns);
    assert.ok(!anyOverlap(out), `overlap at ${columns} columns`);
    assert.ok(
      out.every((l) => l.x >= 0 && l.x + l.w <= columns),
      `off-grid at ${columns} columns`,
    );
  }
});

test("a panel is never narrower than one column", () => {
  const out = reflowLayouts([panel("a", { x: 0, y: 0, w: 1, h: 1 })], 1);
  assert.equal(out[0].w, 1);
});

test("an out-of-range column count is clamped to the grid", () => {
  const panels = [panel("a", { x: 0, y: 0, w: 12, h: 2 })];
  assert.deepEqual(reflowLayouts(panels, 0), [{ x: 0, y: 0, w: 1, h: 2 }]);
  assert.deepEqual(reflowLayouts(panels, 99), [panels[0].layout]);
});

test("gridArea is the CSS shorthand, one-based and span-relative", () => {
  assert.equal(gridArea({ x: 6, y: 2, w: 4, h: 3 }, 12), "3 / 7 / span 3 / span 4");
});

test("gridArea clamps a width the grid cannot hold", () => {
  assert.equal(gridArea({ x: 0, y: 0, w: 12, h: 2 }, 6), "1 / 1 / span 2 / span 6");
});

test("row height shrinks with the breakpoint and is exact on desktop", () => {
  assert.equal(rowHeightAt("lg", 84), 84);
  assert.ok(rowHeightAt("md", 84) < 84);
  assert.ok(rowHeightAt("sm", 84) < rowHeightAt("md", 84));
  // Never zero, however small the surface's own row.
  assert.ok(rowHeightAt("sm", 1) >= 1);
});
