import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { PanelLayoutGrid } from "@/components/dashboard/PanelLayoutGrid";
import { mount } from "./support/dom";

/**
 * The keyboard path into the arranger. The grid math itself is pinned in
 * `test/grid-layout.test.ts`; what needs a mount is that a focused tile
 * actually reaches it — arrows move, Shift+arrows resize, the handle resizes —
 * and that each key press is exactly one change to the spec.
 */

const PANELS: Panel[] = [
  {
    id: "a",
    title: "Requests",
    viz: "line",
    query: { sourceId: "src", sql: "SELECT 1" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  },
  {
    id: "b",
    title: "Errors",
    viz: "bar",
    query: { sourceId: "src", sql: "SELECT 1" },
    layout: { x: 6, y: 0, w: 6, h: 4 },
  },
];

function tile(container: HTMLElement, label: string): HTMLButtonElement {
  const el = [...container.querySelectorAll("button")].find((b) =>
    (b.getAttribute("aria-label") ?? "").startsWith(label),
  );
  assert.ok(el, `no control labelled ${label}`);
  return el as HTMLButtonElement;
}

test("arrow keys move the panel, shift+arrows resize it", async () => {
  const h = await mount();
  const changes: Panel[][] = [];
  try {
    h.render(<PanelLayoutGrid panels={PANELS} onChange={(p) => changes.push(p)} />);
    h.key(tile(h.container, "Requests,"), "ArrowDown");
    assert.equal(changes.length, 1);
    assert.deepEqual(changes[0][0].layout, { x: 0, y: 1, w: 6, h: 4 });

    h.key(tile(h.container, "Requests,"), "ArrowRight", { shiftKey: true });
    assert.equal(changes.length, 2);
    assert.deepEqual(changes[1][0].layout, { x: 0, y: 0, w: 7, h: 4 });
    // Growing into the neighbour pushes it down rather than overlapping it.
    assert.deepEqual(changes[1][1].layout, { x: 6, y: 4, w: 6, h: 4 });
  } finally {
    h.unmount();
  }
});

test("the resize handle resizes with plain arrows", async () => {
  const h = await mount();
  const changes: Panel[][] = [];
  try {
    h.render(<PanelLayoutGrid panels={PANELS} onChange={(p) => changes.push(p)} />);
    h.key(tile(h.container, "Resize Requests"), "ArrowDown");
    assert.deepEqual(changes[0][0].layout, { x: 0, y: 0, w: 6, h: 5 });
  } finally {
    h.unmount();
  }
});

test("a nudge that the bounds refuse is not a change at all", async () => {
  const h = await mount();
  const changes: Panel[][] = [];
  try {
    h.render(<PanelLayoutGrid panels={PANELS} onChange={(p) => changes.push(p)} />);
    // Already at x 0 / y 0, and already 6 wide against a neighbour at x 6.
    h.key(tile(h.container, "Requests,"), "ArrowLeft");
    h.key(tile(h.container, "Requests,"), "ArrowUp");
    // A key the arranger does not own is left to the browser.
    h.key(tile(h.container, "Requests,"), "Tab");
    assert.deepEqual(changes, []);
  } finally {
    h.unmount();
  }
});

test("clicking a tile selects its panel", async () => {
  const h = await mount();
  const selected: string[] = [];
  try {
    h.render(
      <PanelLayoutGrid
        panels={PANELS}
        selectedId="a"
        onSelect={(id) => selected.push(id)}
        onChange={() => assert.fail("selection is not a layout change")}
      />,
    );
    h.click(tile(h.container, "Errors,"));
    assert.deepEqual(selected, ["b"]);
  } finally {
    h.unmount();
  }
});

test("with no panels the arranger says so instead of rendering an empty grid", async () => {
  const h = await mount();
  try {
    h.render(<PanelLayoutGrid panels={[]} onChange={() => {}} />);
    assert.match(h.text(), /No panels yet/);
    assert.equal(h.container.querySelectorAll("button").length, 0);
  } finally {
    h.unmount();
  }
});
