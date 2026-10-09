import assert from "node:assert/strict";
import {
  hasQuery,
  isSqlQuery,
  type Panel,
  type QueryPanel,
  type SqlQuery,
} from "@/lib/ir";

/**
 * A panel's query, asserting it has one. Since #202 `Panel.query` is optional
 * (a text panel has none); a test about a panel that runs SQL says so here
 * rather than with a non-null assertion.
 */
export function queryOf(panel: Panel): SqlQuery {
  assert.ok(panel.query, `panel "${panel.id}" has no query`);
  assert.ok(isSqlQuery(panel.query), `panel "${panel.id}" is not SQL`);
  return panel.query;
}

/** The panel as one that runs a query, asserting it is. */
export function asQueryPanel(panel: Panel): QueryPanel {
  assert.ok(hasQuery(panel), `panel "${panel.id}" has no query`);
  return panel;
}
