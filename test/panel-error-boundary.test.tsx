import { test } from "node:test";
import assert from "node:assert/strict";
import type * as React from "react";
import type { Panel } from "@/lib/ir";
import { DashboardGrid } from "@/components/dashboard/DashboardGrid";
import { PanelView } from "@/components/dashboard/PanelView";
import {
  PanelErrorBoundary,
  type PanelErrorReport,
} from "@/components/dashboard/PanelErrorBoundary";
import { mount } from "./support/dom";

function panel(id: string, overrides: Partial<Panel> = {}): Panel {
  return {
    id,
    title: id,
    viz: "table",
    query: { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
    ...overrides,
  };
}

const DATA = { columns: ["ts", "v"], rows: [{ ts: "t0", v: 41 }] };

/** A component that throws until `stopThrowing` is flipped. */
function makeBomb(message: string) {
  const state = { throwing: true };
  function Bomb(): React.ReactNode {
    if (state.throwing) throw new Error(message);
    return <div>recovered</div>;
  }
  return { Bomb, state };
}

test("a panel that throws degrades to an error card; siblings keep rendering", async () => {
  const h = await mount();
  const { Bomb } = makeBomb("bad row shape");
  const panels = [panel("alpha"), panel("bad"), panel("omega")];

  h.render(
    <DashboardGrid
      panels={panels}
      renderPanel={(p) =>
        p.id === "bad" ? (
          <Bomb />
        ) : (
          <PanelView panel={p} state={{ data: DATA, status: "live" }} />
        )
      }
    />,
  );

  const text = h.text();
  // The broken panel kept its place in the grid and says why.
  assert.match(text, /bad row shape/);
  assert.match(text, /Render error/);
  // Every other panel still rendered its data.
  assert.match(text, /alpha/);
  assert.match(text, /omega/);
  assert.match(text, /41/);
  // Three panels are still in the grid — nothing was unmounted.
  assert.equal(h.container.querySelectorAll("[style*='grid-column']").length, 3);

  h.unmount();
});

test("retry remounts only the failed panel", async () => {
  const h = await mount();
  const { Bomb, state } = makeBomb("transient");
  const panels = [panel("alpha"), panel("bad")];

  const tree = (
    <DashboardGrid
      panels={panels}
      renderPanel={(p) =>
        p.id === "bad" ? (
          <Bomb />
        ) : (
          <PanelView panel={p} state={{ data: DATA, status: "live" }} />
        )
      }
    />
  );

  h.render(tree);
  assert.match(h.text(), /transient/);

  // The underlying cause is gone; Retry should give the subtree another go.
  state.throwing = false;
  const retry = [...h.container.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes("Retry"),
  );
  assert.ok(retry, "expected a Retry button on the error card");
  h.click(retry);

  assert.match(h.text(), /recovered/);
  assert.doesNotMatch(h.text(), /Render error/);
  // The healthy sibling was never disturbed.
  assert.match(h.text(), /alpha/);
  assert.match(h.text(), /41/);

  h.unmount();
});

test("the caught error is reported with the panel id and viz type", async () => {
  const h = await mount();
  const { Bomb } = makeBomb("kaboom");
  const reports: PanelErrorReport[] = [];

  h.render(
    <DashboardGrid
      panels={[panel("p-7", { viz: "heatmap" })]}
      renderPanel={() => <Bomb />}
      onPanelError={(r) => reports.push(r)}
    />,
  );

  assert.equal(reports.length, 1);
  assert.equal(reports[0].panelId, "p-7");
  assert.equal(reports[0].viz, "heatmap");
  assert.equal(reports[0].error.message, "kaboom");

  h.unmount();
});

test("a healthy panel renders untouched through the boundary", async () => {
  const h = await mount();
  const p = panel("solo");

  h.render(
    <PanelErrorBoundary panel={p}>
      <PanelView panel={p} state={{ data: DATA, status: "live" }} />
    </PanelErrorBoundary>,
  );

  assert.match(h.text(), /solo/);
  assert.match(h.text(), /41/);
  assert.doesNotMatch(h.text(), /Render error/);

  h.unmount();
});
