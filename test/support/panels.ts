import assert from "node:assert/strict";
import { hasQuery, type Panel, type PanelQuery, type QueryPanel } from "@/lib/ir";

/**
 * A panel's query, asserting it has one. Since #202 `Panel.query` is optional
 * (a text panel has none); a test about a panel that runs SQL says so here
 * rather than with a non-null assertion.
 */
export function queryOf(panel: Panel): PanelQuery {
  assert.ok(panel.query, `panel "${panel.id}" has no query`);
  return panel.query;
}

/** The panel as one that runs a query, asserting it is. */
export function asQueryPanel(panel: Panel): QueryPanel {
  assert.ok(hasQuery(panel), `panel "${panel.id}" has no query`);
  return panel;
}
