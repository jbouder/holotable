import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel, PanelLayout } from "@/lib/ir";
import { Panel as PanelSchema } from "@/lib/ir";
import {
  applyLayout,
  cellStep,
  clampLayout,
  MAX_HEIGHT,
  MAX_ROW,
  overlaps,
  resolveOverlaps,
  sameLayouts,
  snapDelta,
} from "@/lib/grid-layout";

/**
 * The arranger's guarantees: every layout it produces is inside the IR bounds
 * and free of overlaps, so a dragged arrangement is always something the
 * viewer can render and the API will accept.
 */

function panel(id: string, layout: PanelLayout): Panel {
  return {
    id,
    title: id,
    viz: "line",
    query: { sourceId: "src", sql: "SELECT 1" },
    layout,
  };
}

function anyOverlap(panels: Panel[]): boolean {
  return panels.some((a, i) =>
    panels.slice(i + 1).some((b) => overlaps(a.layout, b.layout)),
  );
}

test("clampLayout keeps every field inside the IR bounds", () => {
  assert.deepEqual(clampLayout({ x: -3, y: -1, w: 0, h: 0 }), {
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  });
  assert.deepEqual(clampLayout({ x: 99, y: 9_999, w: 99, h: 99 }), {
    x: 0,
    y: MAX_ROW,
    w: 12,
    h: MAX_HEIGHT,
  });
  // Fractions from pixel math are snapped, not truncated to nonsense.
  assert.deepEqual(clampLayout({ x: 1.6, y: 2.4, w: 5.5, h: 3.2 }), {
    x: 2,
    y: 2,
    w: 6,
    h: 3,
  });
  // A NaN from an emptied number input falls back to the minimum.
  assert.equal(clampLayout({ x: Number.NaN, y: 0, w: 4, h: 2 }).x, 0);
});

test("clampLayout keeps x + w on the 12-column grid", () => {
  assert.deepEqual(clampLayout({ x: 10, y: 0, w: 6, h: 2 }), {
    x: 6,
    y: 0,
    w: 6,
    h: 2,
  });
  assert.deepEqual(clampLayout({ x: 12, y: 0, w: 1, h: 1 }).x, 11);
});

test("clamped layouts always parse against the IR", () => {
  for (const raw of [
    { x: -5, y: -5, w: -5, h: -5 },
    { x: 40, y: 40_000, w: 40, h: 400 },
    { x: 7.7, y: 0.2, w: 9.9, h: 47.6 },
  ]) {
    const parsed = PanelSchema.safeParse(panel("p", clampLayout(raw)));
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
  }
});

test("a panel dropped onto another pushes it down instead of overlapping", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 6, h: 4 }),
    panel("b", { x: 6, y: 0, w: 6, h: 4 }),
  ];
  const out = applyLayout(panels, "a", { x: 6, y: 0, w: 6, h: 4 });
  // The dragged panel keeps exactly where it was dropped.
  assert.deepEqual(out[0].layout, { x: 6, y: 0, w: 6, h: 4 });
  assert.deepEqual(out[1].layout, { x: 6, y: 4, w: 6, h: 4 });
  assert.equal(anyOverlap(out), false);
});

test("a push cascades through the panels below it", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 12, h: 2 }),
    panel("b", { x: 0, y: 2, w: 12, h: 2 }),
    panel("c", { x: 0, y: 4, w: 12, h: 2 }),
  ];
  const out = applyLayout(panels, "a", { x: 0, y: 0, w: 12, h: 4 });
  assert.deepEqual(
    out.map((p) => p.layout.y),
    [0, 4, 6],
  );
  assert.equal(anyOverlap(out), false);
});

test("resizing wider pushes the neighbour it grows into", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 6, h: 4 }),
    panel("b", { x: 6, y: 0, w: 6, h: 4 }),
  ];
  const out = applyLayout(panels, "a", { x: 0, y: 0, w: 12, h: 4 });
  assert.deepEqual(out[1].layout, { x: 6, y: 4, w: 6, h: 4 });
  assert.equal(anyOverlap(out), false);
});

test("a move into free space disturbs nothing", () => {
  const panels = [
    panel("a", { x: 0, y: 0, w: 6, h: 4 }),
    panel("b", { x: 6, y: 0, w: 6, h: 4 }),
  ];
  const out = applyLayout(panels, "a", { x: 0, y: 8, w: 6, h: 4 });
  assert.deepEqual(out[1].layout, panels[1].layout);
  assert.equal(anyOverlap(out), false);
});

test("resolveOverlaps is order-independent and leaves a clean layout alone", () => {
  const clean = [
    panel("a", { x: 0, y: 0, w: 6, h: 4 }),
    panel("b", { x: 6, y: 0, w: 6, h: 4 }),
    panel("c", { x: 0, y: 4, w: 12, h: 3 }),
  ];
  assert.equal(resolveOverlaps(clean, "a"), clean);
  const reversed = [...clean].reverse();
  assert.deepEqual(
    resolveOverlaps(reversed, "a").map((p) => [p.id, p.layout.y]),
    reversed.map((p) => [p.id, p.layout.y]),
  );
});

test("resolveOverlaps returns panels in their original order", () => {
  const panels = [
    panel("a", { x: 0, y: 4, w: 12, h: 2 }),
    panel("b", { x: 0, y: 0, w: 12, h: 2 }),
    panel("c", { x: 0, y: 2, w: 12, h: 2 }),
  ];
  const out = applyLayout(panels, "b", { x: 0, y: 2, w: 12, h: 2 });
  assert.deepEqual(
    out.map((p) => p.id),
    ["a", "b", "c"],
  );
  assert.equal(anyOverlap(out), false);
});

test("a pile-up on a single cell still terminates without overlaps", () => {
  const panels = Array.from({ length: 8 }, (_, i) =>
    panel(`p${i}`, { x: 0, y: 0, w: 12, h: 3 }),
  );
  const out = resolveOverlaps(panels, "p0");
  assert.equal(anyOverlap(out), false);
  for (const p of out) assert.ok(PanelSchema.safeParse(p).success);
});

test("overlaps only counts shared cells, not shared edges", () => {
  const a = { x: 0, y: 0, w: 6, h: 4 };
  assert.equal(overlaps(a, { x: 6, y: 0, w: 6, h: 4 }), false);
  assert.equal(overlaps(a, { x: 0, y: 4, w: 6, h: 4 }), false);
  assert.equal(overlaps(a, { x: 5, y: 3, w: 6, h: 4 }), true);
});

test("cellStep spans the container and snapDelta rounds to whole cells", () => {
  // 12 columns of 64px with 11 gaps of 16px.
  const step = cellStep(12 * 64 + 11 * 16, 44, 16);
  assert.equal(step.x, 80);
  assert.equal(step.y, 60);
  assert.deepEqual(snapDelta(0, 0, step), { dx: 0, dy: 0 });
  assert.deepEqual(snapDelta(39, 29, step), { dx: 0, dy: 0 });
  assert.deepEqual(snapDelta(41, 31, step), { dx: 1, dy: 1 });
  assert.deepEqual(snapDelta(-160, -120, step), { dx: -2, dy: -2 });
  // A container that has not been measured yet must not divide by zero.
  assert.ok(Number.isFinite(snapDelta(50, 50, cellStep(0)).dx));
});

test("sameLayouts ignores everything but position", () => {
  const a = [panel("a", { x: 0, y: 0, w: 6, h: 4 })];
  const b = [{ ...a[0], title: "renamed" }];
  assert.equal(sameLayouts(a, b), true);
  assert.equal(sameLayouts(a, [panel("a", { x: 1, y: 0, w: 6, h: 4 })]), false);
  assert.equal(sameLayouts(a, []), false);
});
