import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { PanelView } from "@/components/dashboard/PanelView";
import { mount } from "./support/dom";

/**
 * What a panel offers in its header (#76).
 *
 * The menu's *items* cannot be asserted here: Base UI renders the popup
 * through a portal that does not mount under jsdom (the same limitation
 * `test/panel-explainability.test.tsx` records). What a render can state is
 * that the actions exist behind one named trigger — the accessibility half of
 * the issue — and that an unexpanded panel is a card in the grid rather than
 * an overlay. The exports themselves are pure functions, pinned in
 * `test/panel-export.test.ts`.
 */

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "p1",
    title: "Errors",
    viz: "table",
    query: { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

const STATE = {
  data: { columns: ["ts", "v"], rows: [{ ts: "2026-09-22T00:00:00Z", v: 1 }] },
  status: "live" as const,
};

function labels(root: ParentNode): string[] {
  return [...root.querySelectorAll("[aria-label]")].map(
    (el) => el.getAttribute("aria-label") ?? "",
  );
}

test("the panel's actions sit behind one trigger that names the panel", async () => {
  const h = await mount();
  h.render(<PanelView panel={panel()} state={STATE} />);

  assert.ok(
    labels(h.container).includes("Actions for Errors"),
    `expected a named actions trigger, saw ${JSON.stringify(labels(h.container))}`,
  );
  h.unmount();
});

test("a panel that is not expanded is a card in the grid, not an overlay", async () => {
  const h = await mount();
  h.render(<PanelView panel={panel()} state={STATE} />);

  // The backdrop only exists while expanded, so the card is the only child.
  const card = h.container.firstElementChild;
  assert.ok(card, "expected a card");
  assert.equal(h.container.children.length, 1);
  assert.ok(!card.className.includes("fixed"), card.className);
  assert.equal(card.getAttribute("role"), null);
  h.unmount();
});
