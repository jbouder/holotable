import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelSkeleton } from "@/components/dashboard/PanelSkeleton";
import { PANEL_KINDS } from "@/lib/panels/registry";

/*
 * Panel skeletons follow one set of rules (#72): every shape fills the body
 * and clips to it, and a kind draws a silhouette of its own rather than
 * borrowing the bar chart's.
 */

test("every kind's skeleton fills the panel body and never overflows it", () => {
  for (const kind of PANEL_KINDS) {
    const html = renderToStaticMarkup(<PanelSkeleton viz={kind.kind} />);
    assert.match(
      html,
      /^<div class="h-full min-h-0 w-full overflow-hidden">/,
      `${kind.kind}: the skeleton must sit in the full-size clipping wrapper`,
    );
    assert.ok(html.includes("skeleton"), `${kind.kind}: draws no block`);
  }
});

test("only bar-shaped kinds draw the bar chart's silhouette", () => {
  const bars = PANEL_KINDS.filter((k) => k.skeleton === "chart").map((k) => k.kind);
  assert.deepEqual(bars.sort(), ["bar", "histogram", "vega"]);
  // Time series, dots, cells, blocks, rings and log lines each have their own.
  const shapes = Object.fromEntries(PANEL_KINDS.map((k) => [k.kind, k.skeleton]));
  assert.equal(shapes.line, "line");
  assert.equal(shapes.area, "line");
  assert.equal(shapes.scatter, "scatter");
  assert.equal(shapes.heatmap, "cells");
  assert.equal(shapes.treemap, "blocks");
  assert.equal(shapes.logs, "lines");
  assert.equal(shapes.donut, "ring");
  assert.equal(shapes.gauge, "ring");
});
