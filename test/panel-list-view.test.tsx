import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { mount } from "./support/dom";

/**
 * The list's own contract, which the pure helpers in
 * `test/panel-list.test.ts` cannot state: every action has a name, and the one
 * a pointer reaches is the one a screen reader reads.
 *
 * The list this replaced was a `<button>` per panel with a `Trash2` icon and a
 * click handler inside it — a control nested in a control, with no accessible
 * name on the destructive one.
 */

function panel(id: string, title: string): Panel {
  return {
    id,
    title,
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT 1 AS value", timeField: undefined },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };
}

const PANELS = [panel("a", "Requests"), panel("b", "Errors")];

async function render(overrides: Record<string, unknown> = {}) {
  const { PanelList } = await import("@/components/dashboard/PanelList");
  const harness = await mount();
  const calls: string[] = [];
  harness.render(
    <PanelList
      panels={PANELS}
      selectedId="a"
      onSelect={(id) => calls.push(`select:${id}`)}
      onMove={(id, move) => calls.push(`move:${id}:${move}`)}
      onReorder={(id, to) => calls.push(`reorder:${id}:${to}`)}
      onDuplicate={(id) => calls.push(`duplicate:${id}`)}
      onDelete={(id) => calls.push(`delete:${id}`)}
      {...overrides}
    />,
  );
  return { harness, calls };
}

test("every panel's actions are behind one named trigger", async () => {
  const { harness } = await render();
  const triggers = [...harness.container.querySelectorAll("[aria-label]")].map((el) =>
    el.getAttribute("aria-label"),
  );
  assert.deepEqual(triggers, ["Actions for Requests", "Actions for Errors"]);
  harness.unmount();
});

test("the row's only nested control is the select button", async () => {
  const { harness, calls } = await render();
  const rows = [...harness.container.querySelectorAll("li")];
  assert.equal(rows.length, 2);
  for (const row of rows) {
    // The trigger is a button too; what must not be here is a control inside
    // the select button, which is what the old `Trash2` handler was.
    const select = row.querySelector("button");
    assert.ok(select);
    assert.equal(select.querySelector("button"), null);
  }
  harness.click(rows[1].querySelector("button") as Element);
  assert.deepEqual(calls, ["select:b"]);
  harness.unmount();
});

test("the selected panel says so, not just in colour", async () => {
  const { harness } = await render();
  const current = harness.container.querySelector('[aria-current="true"]');
  assert.ok(current);
  assert.match(current.textContent ?? "", /Requests/);
  harness.unmount();
});

test("each row announces its position, which is what reordering changes", async () => {
  const { harness } = await render();
  assert.match(harness.text(), /Panel 1 of 2/);
  assert.match(harness.text(), /Panel 2 of 2/);
  harness.unmount();
});

/* -------------------------------------------------------------------------- */
/* The actions themselves                                                     */
/* -------------------------------------------------------------------------- */

/** Open one row's menu and return its items, in order. */
function open(harness: Awaited<ReturnType<typeof mount>>, label: string): Element[] {
  const trigger = harness.container.querySelector(`[aria-label="${label}"]`);
  assert.ok(trigger, label);
  harness.click(trigger);
  return [...document.querySelectorAll('[role="menuitem"]')];
}

test("every action is a named menu item, not an unlabelled icon", async () => {
  const { harness } = await render();
  const items = open(harness, "Actions for Requests").map((el) =>
    (el.textContent ?? "").trim(),
  );
  assert.deepEqual(items, [
    "Duplicate",
    "Move up",
    "Move down",
    "Move to top",
    "Move to bottom",
    "Delete",
  ]);
  harness.unmount();
});

test("a menu item calls back with its own panel", async () => {
  const { harness, calls } = await render();
  const items = open(harness, "Actions for Errors");
  harness.click(items[0]);
  assert.deepEqual(calls, ["duplicate:b"]);
  harness.unmount();
});

test("a move the panel cannot make is disabled, not silently ignored", async () => {
  const { harness } = await render();
  // "Requests" is first: up and to-top do nothing, down and to-bottom do.
  const items = open(harness, "Actions for Requests");
  const state = items.map((el) => el.getAttribute("data-disabled") !== null);
  assert.deepEqual(state, [false, true, false, true, false, false]);
  harness.unmount();
});

test("the drag handle is not announced — it duplicates the menu", async () => {
  const { harness } = await render();
  const handles = harness.container.querySelectorAll('[draggable="true"]');
  assert.equal(handles.length, 2);
  for (const handle of handles) {
    assert.equal(handle.getAttribute("aria-hidden"), "true");
  }
  harness.unmount();
});
