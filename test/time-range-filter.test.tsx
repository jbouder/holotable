import { test } from "node:test";
import assert from "node:assert/strict";
import type { TimeRange } from "@/lib/ir";
import { TimeRangeFilter } from "@/components/dashboard/TimeRangeFilter";
import { mount } from "./support/dom";

/**
 * The picker's header controls (#75).
 *
 * The popover's contents are out of reach here — Base UI renders the popup
 * through a portal that does not mount under jsdom, the same limitation
 * `test/panel-actions.test.tsx` records — so what a render can state is the
 * part that is always on screen: what the trigger says the window is, whether
 * a frozen window is called out as one, and that shift and zoom emit valid
 * ranges. The arithmetic behind them is pinned in `test/time-range.test.ts`.
 */

const LIVE: TimeRange = { from: "now-1h", to: "now" };
const FIXED: TimeRange = { from: "2026-09-22T09:00:00Z", to: "2026-09-22T10:00:00Z" };

function byLabel(root: ParentNode, label: string): Element {
  const el = root.querySelector(`[aria-label="${label}"]`);
  assert.ok(el, `no control labelled "${label}"`);
  return el;
}

test("the trigger names the current window", async () => {
  const h = await mount();
  h.render(<TimeRangeFilter value={LIVE} onChange={() => {}} />);
  assert.match(h.text(), /1h/);
  h.unmount();
});

test("a rolling window is not badged; a fixed one is, with a way back", async () => {
  const h = await mount();
  h.render(<TimeRangeFilter value={LIVE} onChange={() => {}} />);
  assert.ok(!h.text().includes("Fixed range"));

  let applied: TimeRange | null = null;
  h.render(<TimeRangeFilter value={FIXED} onChange={(r) => (applied = r)} />);
  assert.match(h.text(), /Fixed range/);

  h.click(byLabel(h.container, "Back to live"));
  assert.deepEqual(applied, { from: "now-1h", to: "now" });
  h.unmount();
});

test("shifting back freezes the window; shifting forward returns to live", async () => {
  const h = await mount();
  const ranges: TimeRange[] = [];
  h.render(<TimeRangeFilter value={LIVE} onChange={(r) => ranges.push(r)} />);

  h.click(byLabel(h.container, "Shift back one window"));
  assert.equal(ranges.length, 1);
  assert.ok(!ranges[0].from.startsWith("now"));
  assert.equal(ranges[0].to.endsWith("Z"), true);

  h.render(<TimeRangeFilter value={ranges[0]} onChange={(r) => ranges.push(r)} />);
  h.click(byLabel(h.container, "Shift forward one window"));
  assert.deepEqual(ranges[1], { from: "now-1h", to: "now" });
  h.unmount();
});

test("zooming out widens the window and leaves a live one live", async () => {
  const h = await mount();
  let applied: TimeRange | null = null;
  h.render(<TimeRangeFilter value={LIVE} onChange={(r) => (applied = r)} />);
  h.click(byLabel(h.container, "Zoom out"));
  assert.deepEqual(applied, { from: "now-2h", to: "now" });
  h.unmount();
});
