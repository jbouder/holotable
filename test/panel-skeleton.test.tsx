import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView } from "@/components/dashboard/PanelView";
import { BREAKPOINT_COLUMNS, gridArea, reflowLayouts } from "@/lib/responsive-grid";
import { mount } from "./support/dom";

/**
 * What the loading and responsive work has to be true of in a real render
 * (#72, #78). The arithmetic is pinned as functions in
 * `test/responsive-grid.test.ts`; what is left is the wiring — that a loading
 * panel draws a skeleton rather than a spinner, and that the grid actually
 * ships all three arrangements in the markup instead of measuring the
 * viewport, which is the whole reason the IR is never touched.
 */

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Requests",
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

let harness: Awaited<ReturnType<typeof mount>> | null = null;
afterEach(() => {
  harness?.unmount();
  harness = null;
});

test("a panel with no data yet reserves its shape with a skeleton", async () => {
  harness = await mount();
  harness.render(<PanelView panel={panel()} />);

  const blocks = harness.container.querySelectorAll(".skeleton");
  assert.ok(blocks.length > 0, "expected skeleton blocks in the panel body");
  // Decorative: the shape is not an answer, so it is hidden from the reader
  // who is being read to, and a live region says "loading" instead.
  for (const block of blocks) {
    assert.equal(block.getAttribute("aria-hidden"), "true");
  }
  assert.match(harness.text(), /Loading Requests…/);
});

test("the skeleton takes the shape of the visualization that is coming", async () => {
  harness = await mount();

  harness.render(<PanelView panel={panel({ viz: "donut" })} />);
  assert.ok(
    harness.container.querySelector(".skeleton.rounded-full"),
    "a donut should be stood in for by a circle",
  );

  harness.render(<PanelView panel={panel({ viz: "stat" })} />);
  assert.equal(
    harness.container.querySelector(".skeleton.rounded-full"),
    null,
    "a stat should not be stood in for by a circle",
  );
});

test("a panel with rows renders them instead of a skeleton", async () => {
  harness = await mount();
  harness.render(
    <PanelView
      panel={panel({ viz: "table" })}
      state={{
        status: "live",
        data: { columns: ["ts", "v"], rows: [{ ts: "t0", v: 41 }] },
      }}
    />,
  );
  assert.equal(harness.container.querySelector(".skeleton"), null);
  assert.match(harness.text(), /41/);
});

test("the grid ships every breakpoint's arrangement as CSS", async () => {
  const panels = [
    panel({ id: "a", layout: { x: 0, y: 0, w: 6, h: 4 } }),
    panel({ id: "b", layout: { x: 6, y: 0, w: 6, h: 4 } }),
  ];
  harness = await mount();
  harness.render(
    <DashboardGrid panels={panels} renderPanel={(p) => <div>{p.id}</div>} />,
  );

  const cells = harness.container.querySelectorAll<HTMLElement>("[style*='--area-lg']");
  assert.equal(cells.length, 2);

  for (const [i, cell] of [...cells].entries()) {
    // The desktop arrangement is the IR's own coordinates, unchanged.
    assert.equal(
      cell.style.getPropertyValue("--area-lg").trim(),
      gridArea(panels[i].layout, BREAKPOINT_COLUMNS.lg),
    );
    // The narrower two are the re-flow, shipped alongside rather than swapped
    // in by a resize listener.
    assert.equal(
      cell.style.getPropertyValue("--area-md").trim(),
      gridArea(reflowLayouts(panels, BREAKPOINT_COLUMNS.md)[i], BREAKPOINT_COLUMNS.md),
    );
    assert.equal(
      cell.style.getPropertyValue("--area-sm").trim(),
      gridArea(reflowLayouts(panels, BREAKPOINT_COLUMNS.sm)[i], BREAKPOINT_COLUMNS.sm),
    );
  }
});

test("rendering responsively leaves the panels themselves alone", async () => {
  const layout = { x: 6, y: 2, w: 6, h: 4 };
  const panels = [panel({ id: "a", layout })];
  harness = await mount();
  harness.render(<DashboardGrid panels={panels} renderPanel={() => null} />);

  // The invariant the issue turns on: a dashboard looked at on a phone is
  // still the 12-column dashboard that was saved.
  assert.deepEqual(panels[0].layout, layout);
  assert.equal(panels[0].layout, layout);
});

test("a non-responsive grid keeps twelve columns at every width", async () => {
  const panels = [panel({ id: "a", layout: { x: 3, y: 1, w: 3, h: 2 } })];
  harness = await mount();
  harness.render(
    <DashboardGrid panels={panels} responsive={false} renderPanel={() => null} />,
  );
  const cell = harness.container.querySelector<HTMLElement>("[style*='--area-lg']");
  assert.ok(cell);
  const area = gridArea(panels[0].layout, 12);
  assert.equal(cell.style.getPropertyValue("--area-sm").trim(), area);
  assert.equal(cell.style.getPropertyValue("--area-md").trim(), area);
  assert.equal(cell.style.getPropertyValue("--area-lg").trim(), area);
});
