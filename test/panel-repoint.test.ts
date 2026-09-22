import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Panel } from "@/lib/ir";
import {
  checkRepoint,
  missingSourceIds,
  panelsUsingSource,
  repointPanels,
  summarizeChecks,
} from "@/lib/panel-repoint";

function panel(id: string, sourceId: string, sql = "SELECT 1 AS value"): Panel {
  return {
    id,
    title: `Panel ${id}`,
    viz: "line",
    query: { sourceId, sql, timeField: "ts" },
    layout: { x: 0, y: 0, w: 6, h: 4 },
  };
}

const PANELS = [panel("a", "dead"), panel("b", "live"), panel("c", "dead")];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test("a source no live source matches is missing, listed once, in panel order", () => {
  assert.deepEqual(missingSourceIds(PANELS, ["live"]), ["dead"]);
  assert.deepEqual(missingSourceIds([panel("a", "x"), panel("b", "y")], []), ["x", "y"]);
  assert.deepEqual(missingSourceIds(PANELS, ["live", "dead"]), []);
});

test("the bulk set is every panel on that source", () => {
  assert.deepEqual(
    panelsUsingSource(PANELS, "dead").map((p) => p.id),
    ["a", "c"],
  );
});

test("re-pointing moves the source reference and nothing else", () => {
  const moved = repointPanels(PANELS, { panelIds: ["a"], sourceId: "live" });
  assert.equal(moved[0].query.sourceId, "live");
  // The panel keeps its identity: an id change would orphan the layout, the
  // selection and anything else that refers to the panel by id.
  assert.equal(moved[0].id, "a");
  assert.deepEqual(
    { ...moved[0], query: { ...moved[0].query, sourceId: "dead" } },
    PANELS[0],
  );
  // Untouched panels are untouched.
  assert.deepEqual(moved.slice(1), PANELS.slice(1));
});

test("re-pointing does not mutate the panels it was given", () => {
  const before = structuredClone(PANELS);
  repointPanels(PANELS, { panelIds: ["a", "c"], sourceId: "live" });
  assert.deepEqual(PANELS, before);
});

test("an unselected panel is left on the dead source", () => {
  const moved = repointPanels(PANELS, { panelIds: ["a"], sourceId: "live" });
  assert.equal(moved[2].query.sourceId, "dead");
});

test("each panel is checked against the new source, and the verdicts keep their panel", async () => {
  const bodies: unknown[] = [];
  globalThis.fetch = (async (_input: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return new Response(
      JSON.stringify(
        body.sql.includes("errors")
          ? { ok: false, error: "table errors is not in the source catalog" }
          : { ok: true },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  const checks = await checkRepoint(
    [panel("a", "dead"), panel("c", "dead", "SELECT n FROM errors")],
    "live",
  );

  assert.deepEqual(bodies, [
    { sourceId: "live", sql: "SELECT 1 AS value" },
    { sourceId: "live", sql: "SELECT n FROM errors" },
  ]);
  assert.deepEqual(
    checks.map((c) => [c.panelId, c.check.ok]),
    [
      ["a", true],
      ["c", false],
    ],
  );
  const failed = checks[1].check;
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.error.kind, "statement");
  assert.equal(
    summarizeChecks(checks),
    "1 of 2 panels still validate against this source",
  );
});

test("one panel is summarized in the singular", () => {
  assert.equal(
    summarizeChecks([{ panelId: "a", title: "A", check: { ok: true } }]),
    "1 of 1 panel still validates against this source",
  );
});
