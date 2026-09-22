import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  appendPanel,
  bottomOf,
  listEditableDashboards,
  newDashboardSpec,
  panelIdFromTitle,
  saveToExistingDashboard,
  saveToNewDashboard,
  uniquePanelId,
} from "@/lib/explore-save";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "explore",
    title: "Error rate by route",
    viz: "table",
    query: { sourceId: "src-1", sql: "SELECT route, n FROM errors", timeField: "ts" },
    layout: { x: 0, y: 0, w: 12, h: 4 },
    ...overrides,
  };
}

function dashboard(panels: Panel[]): Dashboard {
  return {
    title: "Ops",
    timeRange: { from: "now-24h", to: "now" },
    refreshIntervalMs: 15_000,
    panels,
  };
}

/* -------------------------------------------------------------------------- */
/* Placement                                                                  */
/* -------------------------------------------------------------------------- */

test("an id is slugged from the title, not left as the fixed explore id", () => {
  assert.equal(panelIdFromTitle("Error rate by route"), "error-rate-by-route");
  assert.equal(panelIdFromTitle("p95 latency (ms)!"), "p95-latency-ms");
  assert.equal(panelIdFromTitle("  ???  "), "panel");
});

test("a slugged id stays inside the IR's 64-character cap", () => {
  const id = panelIdFromTitle("x".repeat(200));
  assert.ok(id.length <= 64, `id was ${id.length} characters`);
});

test("uniquePanelId walks past every collision", () => {
  assert.equal(uniquePanelId([], "errors"), "errors");
  assert.equal(uniquePanelId(["errors"], "errors"), "errors-2");
  assert.equal(uniquePanelId(["errors", "errors-2"], "errors"), "errors-3");
});

test("bottomOf is below the tallest panel, and clamped to the layout maximum", () => {
  assert.equal(bottomOf([]), 0);
  assert.equal(
    bottomOf([
      panel({ layout: { x: 0, y: 0, w: 6, h: 4 } }),
      panel({ layout: { x: 6, y: 0, w: 6, h: 8 } }),
    ]),
    8,
  );
  assert.equal(bottomOf([panel({ layout: { x: 0, y: 1000, w: 12, h: 48 } })]), 1000);
});

test("appendPanel places the panel at the bottom under a unique id", () => {
  const spec = dashboard([
    panel({ id: "error-rate-by-route", layout: { x: 0, y: 0, w: 6, h: 5 } }),
  ]);
  const next = appendPanel(spec, panel());

  assert.equal(next.panels.length, 2);
  assert.equal(next.panels[1].id, "error-rate-by-route-2");
  assert.deepEqual(next.panels[1].layout, { x: 0, y: 5, w: 12, h: 4 });
  // Pure: the input spec is untouched.
  assert.equal(spec.panels.length, 1);
});

test("appendPanel carries the panel's query and viz through unchanged", () => {
  const p = panel();
  const next = appendPanel(dashboard([panel({ id: "other" })]), p);
  assert.deepEqual(next.panels[1].query, p.query);
  assert.equal(next.panels[1].viz, p.viz);
  assert.equal(next.panels[1].title, p.title);
});

test("newDashboardSpec holds one panel at the origin with the given defaults", () => {
  const spec = newDashboardSpec({
    title: "  Errors  ",
    panel: panel(),
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
  });
  assert.equal(spec.title, "Errors");
  assert.equal(spec.refreshIntervalMs, 30_000);
  assert.deepEqual(spec.timeRange, { from: "now-1h", to: "now" });
  assert.equal(spec.panels.length, 1);
  assert.equal(spec.panels[0].id, "error-rate-by-route");
  assert.deepEqual(spec.panels[0].layout, { x: 0, y: 0, w: 12, h: 4 });
});

/* -------------------------------------------------------------------------- */
/* API helpers                                                                */
/* -------------------------------------------------------------------------- */

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(responses: Response[]): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

test("the picker asks for one workspace and only editable dashboards", async () => {
  const calls = stubFetch([
    jsonResponse({ dashboards: [{ id: "d1", title: "Ops", workspaceId: "ws-a" }] }),
  ]);
  const outcome = await listEditableDashboards("ws-a");

  assert.ok(outcome.ok);
  assert.deepEqual(outcome.dashboards, [{ id: "d1", title: "Ops" }]);
  const url = new URL(calls[0].url, "http://localhost");
  assert.equal(url.searchParams.get("workspaceId"), "ws-a");
  assert.equal(url.searchParams.get("editable"), "true");
});

test("a malformed list body yields no options rather than throwing", async () => {
  stubFetch([
    jsonResponse({ dashboards: [{ id: 1 }, null, { id: "d1", title: "Ops" }] }),
  ]);
  const outcome = await listEditableDashboards("ws-a");
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.dashboards, [{ id: "d1", title: "Ops" }]);
});

test("a failed list is reported as an error, not an empty picker", async () => {
  stubFetch([jsonResponse({ error: "nope", kind: "authorization" }, { status: 403 })]);
  const outcome = await listEditableDashboards("ws-a");
  assert.equal(outcome.ok, false);
});

test("saving to an existing dashboard PUTs the stored spec plus the panel", async () => {
  const stored = dashboard([
    panel({ id: "existing", layout: { x: 0, y: 0, w: 12, h: 6 } }),
  ]);
  const calls = stubFetch([
    jsonResponse({ dashboard: { id: "d1", spec: stored } }),
    jsonResponse({ dashboard: { id: "d1", version: 2 } }),
  ]);

  const outcome = await saveToExistingDashboard("d1", panel());
  assert.ok(outcome.ok);
  assert.equal(outcome.dashboardId, "d1");
  assert.equal(outcome.panelId, "error-rate-by-route");

  assert.equal(calls[0].method, "GET");
  assert.equal(calls[1].method, "PUT");
  const sent = (calls[1].body as { spec: Dashboard }).spec;
  assert.equal(sent.panels.length, 2);
  assert.equal(sent.panels[1].id, "error-rate-by-route");
  assert.equal(sent.panels[1].layout.y, 6);
  // The rest of the dashboard is preserved: a save appends, never replaces.
  assert.equal(sent.title, stored.title);
  assert.equal(sent.panels[0].id, "existing");
});

test("a dashboard that cannot be read is not overwritten", async () => {
  const calls = stubFetch([
    jsonResponse({ error: "not found", kind: "not_found" }, { status: 404 }),
  ]);
  const outcome = await saveToExistingDashboard("d1", panel());
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 1, "no PUT is attempted");
});

test("a spec that would break the IR is rejected before it is sent", async () => {
  const full = dashboard(
    Array.from({ length: 50 }, (_, i) =>
      panel({ id: `p${i}`, layout: { x: 0, y: i, w: 12, h: 1 } }),
    ),
  );
  const calls = stubFetch([jsonResponse({ dashboard: { id: "d1", spec: full } })]);
  const outcome = await saveToExistingDashboard("d1", panel());
  assert.equal(outcome.ok, false);
  assert.equal(calls.length, 1, "no PUT is attempted");
});

test("creating a dashboard POSTs a one-panel spec and returns its id", async () => {
  const calls = stubFetch([jsonResponse({ dashboard: { id: "d9" } }, { status: 201 })]);
  const outcome = await saveToNewDashboard({
    title: "Errors",
    panel: panel(),
    timeRange: { from: "now-24h", to: "now" },
    refreshIntervalMs: 15_000,
  });

  assert.ok(outcome.ok);
  assert.equal(outcome.dashboardId, "d9");
  assert.equal(outcome.panelId, "error-rate-by-route");
  assert.equal(calls[0].method, "POST");
  const sent = (calls[0].body as { spec: Dashboard }).spec;
  assert.equal(sent.panels.length, 1);
  assert.equal(sent.title, "Errors");
});

test("a rejected create is surfaced with the server's error", async () => {
  stubFetch([
    jsonResponse(
      {
        error: "all panels in a dashboard must belong to the same workspace",
        kind: "validation",
      },
      { status: 400 },
    ),
  ]);
  const outcome = await saveToNewDashboard({
    title: "Errors",
    panel: panel(),
    timeRange: { from: "now-24h", to: "now" },
    refreshIntervalMs: 15_000,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok === false ? outcome.error.error : "", /same workspace/);
});
