import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  activeSpec,
  appendTurn,
  EMPTY_HISTORY,
  normalizeTurn,
  restoreTurn,
  type TurnHistory,
} from "@/lib/dashboard-turns";

function panel(id: string, overrides: Partial<Panel> = {}): Panel {
  return {
    id,
    title: id,
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT m, n FROM t", timeField: "m" },
    layout: { x: 0, y: 0, w: 12, h: 4 },
    ...overrides,
  };
}

function dashboard(title: string, panels: Panel[]): Dashboard {
  return {
    title,
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 15_000,
    panels,
  };
}

/** Build a history of `n` turns named "t1".."tn", each with one panel. */
function history(n: number): TurnHistory {
  let h = EMPTY_HISTORY;
  for (let i = 1; i <= n; i++) {
    h = appendTurn(h, { prompt: `p${i}`, spec: dashboard(`t${i}`, [panel(`a${i}`)]) });
  }
  return h;
}

test("an empty history previews nothing", () => {
  assert.equal(activeSpec(EMPTY_HISTORY), null);
  assert.deepEqual(EMPTY_HISTORY.turns, []);
});

test("the first turn becomes the active one", () => {
  const h = appendTurn(EMPTY_HISTORY, {
    prompt: "latency",
    spec: dashboard("Latency", [panel("a")]),
  });
  assert.equal(h.turns.length, 1);
  assert.equal(h.index, 0);
  assert.equal(activeSpec(h)?.title, "Latency");
});

test("each turn is appended and previewed in order", () => {
  const h = history(3);
  assert.deepEqual(
    h.turns.map((t) => t.prompt),
    ["p1", "p2", "p3"],
  );
  assert.equal(h.index, 2);
  assert.equal(activeSpec(h)?.title, "t3");
});

test("turn ids are unique and stable across a restore", () => {
  const h = history(3);
  const ids = h.turns.map((t) => t.id);
  assert.equal(new Set(ids).size, 3);
  assert.deepEqual(
    restoreTurn(h, 0).turns.map((t) => t.id),
    ids,
  );
});

test("restoring a previous turn previews it without dropping anything", () => {
  const restored = restoreTurn(history(3), 0);
  assert.equal(restored.index, 0);
  assert.equal(restored.turns.length, 3);
  assert.equal(activeSpec(restored)?.title, "t1");
});

test("an out-of-range restore is ignored", () => {
  const h = history(2);
  assert.equal(restoreTurn(h, -1), h);
  assert.equal(restoreTurn(h, 2), h);
});

test("refining from a restored turn drops the turns that followed it", () => {
  const branched = appendTurn(restoreTurn(history(3), 0), {
    prompt: "instead make it a bar chart",
    spec: dashboard("bar", [panel("b")]),
  });
  assert.deepEqual(
    branched.turns.map((t) => t.prompt),
    ["p1", "instead make it a bar chart"],
  );
  assert.equal(branched.index, 1);
  assert.equal(activeSpec(branched)?.title, "bar");
});

test("a truncated turn's id is never reused", () => {
  const h = history(3);
  const dropped = h.turns.slice(1).map((t) => t.id);
  const branched = appendTurn(restoreTurn(h, 0), {
    prompt: "again",
    spec: dashboard("again", [panel("c")]),
  });
  const newId = branched.turns[1]?.id;
  assert.ok(newId);
  assert.ok(!dropped.includes(newId));
});

test("appending never mutates the history it was given", () => {
  const h = history(2);
  const before = JSON.stringify(h);
  appendTurn(h, { prompt: "p3", spec: dashboard("t3", [panel("a3")]) });
  restoreTurn(h, 0);
  assert.equal(JSON.stringify(h), before);
});

test("a turn's panels are laid out two-up, without overlaps", () => {
  const turn = normalizeTurn(
    "three panels",
    // Overlapping guesses of the kind the model actually emits.
    dashboard("Ops", [
      panel("a", { layout: { x: 0, y: 0, w: 12, h: 4 } }),
      panel("b", { layout: { x: 0, y: 0, w: 12, h: 6 } }),
      panel("c", { layout: { x: 0, y: 0, w: 12, h: 3 } }),
    ]),
  );
  assert.deepEqual(
    turn.spec.panels.map((p) => p.layout),
    [
      { x: 0, y: 0, w: 6, h: 4 },
      { x: 6, y: 0, w: 6, h: 6 },
      { x: 0, y: 6, w: 6, h: 3 },
    ],
  );
  assert.equal(turn.prompt, "three panels");
});

test("normalizing keeps the rest of the spec and does not mutate the input", () => {
  const spec = dashboard("Ops", [panel("a")]);
  const turn = normalizeTurn("x", spec);
  assert.equal(turn.spec.title, "Ops");
  assert.equal(turn.spec.refreshIntervalMs, 15_000);
  assert.deepEqual(turn.spec.timeRange, { from: "now-1h", to: "now" });
  assert.deepEqual(spec.panels[0]?.layout, { x: 0, y: 0, w: 12, h: 4 });
});
