import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelCardSkeleton } from "@/components/dashboard/PanelSkeleton";
import { PANEL_RENDERERS } from "@/components/panels/registry";
import { VIZ_GUIDE } from "@/lib/ai/generate";
import { Panel, VizType } from "@/lib/ir";
import { upgradeSpec } from "@/lib/ir/upgrade";
import {
  findPanelKind,
  PANEL_KIND_NAMES,
  PANEL_KINDS,
  panelKind,
} from "@/lib/panels/registry";

/*
 * The panel registry (#61): one list of kinds, from which the IR's enum, the
 * prompt and the renderers are all derived, so they cannot disagree.
 */

function panel(viz: unknown): unknown {
  return {
    id: "p1",
    title: "Requests",
    viz,
    query: { sourceId: "src-1", sql: "SELECT 1 AS v" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };
}

/** The smallest valid panel of a registered kind: what that kind asks for. */
function validPanel(viz: (typeof PANEL_KIND_NAMES)[number]): unknown {
  const kind = panelKind(viz);
  const base = panel(viz) as Record<string, unknown>;
  if (kind.query === "none") delete base.query;
  if (kind.requiresTimeField) {
    base.query = { sourceId: "src-1", sql: "SELECT now() AS ts", timeField: "ts" };
  }
  if (kind.starterOptions) base.options = kind.starterOptions("Requests");
  return base;
}

test("every kind there was before the registry is still registered, in the same order", () => {
  // The order is the editor's picker and the model's schema: the original
  // nine unchanged, new kinds after them.
  assert.deepEqual(VizType.options.slice(0, 9), [
    "line",
    "area",
    "bar",
    "scatter",
    "stat",
    "table",
    "heatmap",
    "pie",
    "donut",
  ]);
  assert.deepEqual(VizType.options.slice(9), [
    "gauge",
    "state-timeline",
    "status-grid",
    "histogram",
    "text",
  ]);
  assert.deepEqual(VizType.options, PANEL_KIND_NAMES);
});

test("kind names are unique, and each is described for a person and for the model", () => {
  assert.equal(new Set(PANEL_KIND_NAMES).size, PANEL_KIND_NAMES.length);
  for (const kind of PANEL_KINDS) {
    assert.match(kind.kind, /^[a-z][a-z-]*$/, kind.kind);
    // One line each: the docs table and the prompt list are one row per kind.
    assert.match(kind.summary, /^[^\n]{10,}$/, `${kind.kind} summary`);
    assert.match(kind.promptHint, /^[^\n]{10,}$/, `${kind.kind} promptHint`);
    assert.equal(panelKind(kind.kind), kind);
  }
});

test("every registered kind has a renderer, and nothing else does", () => {
  assert.deepEqual(Object.keys(PANEL_RENDERERS).sort(), [...PANEL_KIND_NAMES].sort());
});

test("a kind is drawn on a canvas exactly when its renderer is a chart", () => {
  // `canvas` is what the code that cannot import React (PNG export, explore)
  // goes by; the renderer is what is actually drawn.
  for (const kind of PANEL_KINDS) {
    assert.equal(
      PANEL_RENDERERS[kind.kind].type === "chart",
      kind.canvas,
      `${kind.kind}: canvas says ${kind.canvas}`,
    );
    if (kind.timeBrush) assert.ok(kind.canvas, `${kind.kind} brushes but is not a chart`);
  }
});

test("an unregistered kind fails validation, naming the kinds there are", () => {
  const result = Panel.safeParse(panel("sparkline"));
  assert.equal(result.success, false);
  const message = result.error?.issues[0]?.message ?? "";
  assert.match(message, /unknown panel kind "sparkline"/);
  for (const name of PANEL_KIND_NAMES) assert.ok(message.includes(name), name);

  // A huge value is not echoed back whole.
  const long = Panel.safeParse(panel("x".repeat(10_000)));
  assert.ok((long.error?.issues[0]?.message.length ?? 0) < 400);

  // A missing or non-string viz keeps the ordinary message.
  for (const viz of [undefined, 3, null]) {
    const r = Panel.safeParse(panel(viz));
    assert.equal(r.success, false);
    assert.doesNotMatch(r.error?.issues[0]?.message ?? "", /unknown panel kind/);
  }
});

test("a stored spec of every registered kind still loads", () => {
  for (const viz of PANEL_KIND_NAMES) {
    const spec = upgradeSpec({
      title: "t",
      timeRange: { from: "now-1h", to: "now" },
      refreshIntervalMs: 30_000,
      panels: [validPanel(viz)],
    });
    assert.equal(spec.panels[0].viz, viz);
  }
});

test("the prompt offers exactly the registered kinds, with each one's hint", () => {
  const lines = VIZ_GUIDE.split("\n");
  assert.equal(lines.length, PANEL_KINDS.length);
  PANEL_KINDS.forEach((kind, i) => {
    assert.equal(lines[i], `- '${kind.kind}': ${kind.promptHint}`);
  });
});

test("a kind still streaming in draws as a chart until it is one", () => {
  const radial = (viz?: string) =>
    renderToStaticMarkup(<PanelCardSkeleton viz={viz} />).includes("rounded-full");
  assert.equal(radial("donut"), true);
  assert.equal(radial("do"), false);
  assert.equal(radial(undefined), false);
  assert.equal(findPanelKind("do"), undefined);
  assert.equal(findPanelKind(42), undefined);
});

/** Every source file under `src/`. */
function sourceFiles(dir = join(process.cwd(), "src")): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

test("nothing outside the registry dispatches on the kind", () => {
  // The closed switches the registry replaced. A feature that only cares
  // about one kind (the chat history naming a stat) may still compare it.
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(
      text,
      /switch\s*\(\s*[\w.]*viz\s*\)/,
      `${relative(process.cwd(), file)} switches on viz; register the kind instead`,
    );
  }
});

test("every kind's loading silhouette draws something", () => {
  for (const kind of PANEL_KINDS) {
    const markup = renderToStaticMarkup(<PanelCardSkeleton viz={kind.kind} />);
    // The header's own blocks are two; the body adds its shape.
    assert.ok((markup.match(/skeleton/g) ?? []).length > 2, kind.kind);
  }
});
