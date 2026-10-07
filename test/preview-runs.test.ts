import { test } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import { panelsToRun, previewRunKey } from "@/lib/preview-runs";

/*
 * The editor's canvas runs a panel's preview again only when its result could
 * differ (#357): a moved, renamed or restyled panel keeps the rows it had.
 */

const RANGE = { from: "now-1h", to: "now" };
const PANEL: Panel = {
  id: "a",
  title: "Requests",
  viz: "line",
  query: { sourceId: "src", sql: "SELECT 1 AS value", timeField: "ts" },
  layout: { x: 0, y: 0, w: 6, h: 4 },
};

function ranKeys(panels: Panel[], variables = {}) {
  return Object.fromEntries(
    panelsToRun(panels, RANGE, variables, {}).map(({ panel, key }) => [panel.id, key]),
  );
}

test("every query panel runs the first time; a text panel never does", () => {
  const text: Panel = {
    id: "t",
    title: "Notes",
    viz: "text",
    options: { content: "hi" },
    layout: { x: 6, y: 0, w: 6, h: 4 },
  };
  assert.deepEqual(
    panelsToRun([PANEL, text], RANGE, {}, {}).map((r) => r.panel.id),
    ["a"],
  );
});

test("moving, renaming or restyling a panel does not run it again", () => {
  const last = ranKeys([PANEL]);
  const changed: Panel = {
    ...PANEL,
    title: "Renamed",
    viz: "bar",
    layout: { x: 6, y: 2, w: 3, h: 2 },
    options: { legend: { show: false } },
  };
  assert.deepEqual(panelsToRun([changed], RANGE, {}, last), []);
});

test("its SQL, its own window, the dashboard window or a variable runs it again", () => {
  const last = ranKeys([PANEL]);
  const sql = { ...PANEL, query: { ...PANEL.query, sql: "SELECT 2 AS value" } } as Panel;
  assert.equal(panelsToRun([sql], RANGE, {}, last).length, 1);
  const own = { ...PANEL, timeRange: { from: "now-6h", to: "now" } } as Panel;
  assert.equal(panelsToRun([own], RANGE, {}, last).length, 1);
  assert.equal(panelsToRun([PANEL], { from: "now-24h", to: "now" }, {}, last).length, 1);
  assert.equal(panelsToRun([PANEL], RANGE, { service: "api" }, last).length, 1);
});

test("a panel with its own window ignores a change to the dashboard's", () => {
  const own = { ...PANEL, timeRange: { from: "now-6h", to: "now" } } as Panel;
  if (!own.query) throw new Error("query panel");
  const before = previewRunKey(own as Parameters<typeof previewRunKey>[0], RANGE, {});
  const after = previewRunKey(
    own as Parameters<typeof previewRunKey>[0],
    { from: "now-24h", to: "now" },
    {},
  );
  assert.equal(before, after);
});
