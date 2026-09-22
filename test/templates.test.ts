import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dashboard, Panel } from "@/lib/ir";
import {
  TemplateBody,
  TemplateCreate,
  appendTemplate,
  dashboardTemplateBody,
  panelTemplateBody,
  readTemplates,
  retargetTemplate,
  summarizeTemplate,
  templatePanels,
  templateSourceIds,
  templateSpec,
  templateValidationSpec,
} from "@/lib/templates";

function panel(overrides: Partial<Panel> = {}): Panel {
  return {
    id: "requests",
    title: "Requests",
    viz: "line",
    query: { sourceId: "src-1", sql: "SELECT ts, value FROM metrics", timeField: "ts" },
    layout: { x: 3, y: 9, w: 6, h: 4 },
    ...overrides,
  };
}

function dashboard(overrides: Partial<Dashboard> = {}): Dashboard {
  return {
    title: "Service",
    timeRange: { from: "now-6h", to: "now" },
    refreshIntervalMs: 60_000,
    panels: [
      panel(),
      panel({ id: "errors", title: "Errors", layout: { x: 6, y: 0, w: 6, h: 4 } }),
    ],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* The body is the IR                                                         */
/* -------------------------------------------------------------------------- */

test("a body is a Panel or a Dashboard, tagged, and nothing else", () => {
  assert.equal(TemplateBody.safeParse({ kind: "panel", panel: panel() }).success, true);
  assert.equal(
    TemplateBody.safeParse({ kind: "dashboard", dashboard: dashboard() }).success,
    true,
  );
  // A tag with the wrong payload, an untagged spec and an extra field are all
  // refused: the discriminated union plus `.strict()` is the whole check.
  assert.equal(
    TemplateBody.safeParse({ kind: "panel", dashboard: dashboard() }).success,
    false,
  );
  assert.equal(TemplateBody.safeParse({ panel: panel() }).success, false);
  assert.equal(
    TemplateBody.safeParse({ kind: "panel", panel: panel(), sql: "SELECT 1" }).success,
    false,
  );
});

test("a body that is not valid IR is refused on write", () => {
  const bad = { ...panel(), query: { sourceId: "s", sql: "SELECT 1", drop: true } };
  assert.equal(TemplateBody.safeParse({ kind: "panel", panel: bad }).success, false);
});

test("the create payload carries no kind of its own", () => {
  const parsed = TemplateCreate.safeParse({
    workspaceId: "demo",
    name: "Golden",
    kind: "panel",
    body: { kind: "panel", panel: panel() },
  });
  assert.equal(parsed.success, false, "kind beside the body would be a second opinion");
});

/* -------------------------------------------------------------------------- */
/* Re-pointing                                                                */
/* -------------------------------------------------------------------------- */

test("retargeting moves every panel's source and nothing else", () => {
  const body = dashboardTemplateBody(dashboard());
  const moved = retargetTemplate(body, "src-2");

  assert.deepEqual(templateSourceIds(moved), ["src-2"]);
  assert.deepEqual(
    templatePanels(moved).map((p) => ({
      ...p,
      query: { ...p.query, sourceId: "src-1" },
    })),
    templatePanels(body),
    "only query.sourceId differs",
  );
});

test("retargeting does not mutate the template it was given", () => {
  const body = panelTemplateBody(panel());
  const before = structuredClone(body);
  retargetTemplate(body, "somewhere-else");
  assert.deepEqual(body, before);
});

test("the source ids are distinct and in spec order", () => {
  const body = dashboardTemplateBody(
    dashboard({
      panels: [
        panel({ id: "a", query: { sourceId: "b", sql: "SELECT 1" } }),
        panel({ id: "b", query: { sourceId: "a", sql: "SELECT 1" } }),
        panel({ id: "c", query: { sourceId: "b", sql: "SELECT 1" } }),
      ],
    }),
  );
  assert.deepEqual(templateSourceIds(body), ["b", "a"]);
});

/* -------------------------------------------------------------------------- */
/* Instantiation                                                              */
/* -------------------------------------------------------------------------- */

test("a dashboard template keeps its arrangement, range and refresh", () => {
  const source = dashboard();
  const spec = templateSpec(dashboardTemplateBody(source), {
    title: "  Payments  ",
    sourceId: "src-9",
  });

  assert.equal(spec.title, "Payments");
  assert.deepEqual(spec.timeRange, source.timeRange);
  assert.equal(spec.refreshIntervalMs, source.refreshIntervalMs);
  assert.deepEqual(
    spec.panels.map((p) => p.layout),
    source.panels.map((p) => p.layout),
    "the layout is most of what made it worth saving",
  );
  assert.deepEqual([...new Set(spec.panels.map((p) => p.query.sourceId))], ["src-9"]);
});

test("a panel template becomes a one-panel dashboard at the origin", () => {
  const spec = templateSpec(panelTemplateBody(panel()), {
    title: "Just the one",
    sourceId: "src-9",
  });
  assert.equal(spec.panels.length, 1);
  assert.deepEqual(spec.panels[0].layout, { x: 0, y: 0, w: 6, h: 4 });
  assert.equal(spec.panels[0].query.sourceId, "src-9");
});

test("appending a template stacks its panels under unique ids", () => {
  const existing: Dashboard = dashboard({
    panels: [panel({ id: "requests", layout: { x: 0, y: 0, w: 12, h: 5 } })],
  });
  const next = appendTemplate(existing, dashboardTemplateBody(dashboard()), "src-2");

  assert.equal(next.panels.length, 3);
  assert.equal(new Set(next.panels.map((p) => p.id)).size, 3, "no id collides");
  // The second appended panel sees the bottom edge the first one produced.
  assert.ok(next.panels[2].layout.y >= next.panels[1].layout.y + next.panels[1].layout.h);
  assert.deepEqual(
    [...new Set(next.panels.slice(1).map((p) => p.query.sourceId))],
    ["src-2"],
  );
});

test("appending does not touch the spec it was given", () => {
  const existing = dashboard();
  const before = structuredClone(existing);
  appendTemplate(existing, panelTemplateBody(panel()), "src-2");
  assert.deepEqual(existing, before);
});

/* -------------------------------------------------------------------------- */
/* Saving                                                                     */
/* -------------------------------------------------------------------------- */

test("a saved panel keeps its size and loses its position", () => {
  const body = panelTemplateBody(panel({ layout: { x: 6, y: 12, w: 4, h: 7 } }));
  assert.deepEqual(templatePanels(body)[0].layout, { x: 0, y: 0, w: 4, h: 7 });
});

test("saving refuses a spec that is not valid IR", () => {
  assert.throws(() => panelTemplateBody({ ...panel(), title: "" } as Panel));
});

test("the validation spec is a parseable dashboard for either kind", () => {
  for (const body of [panelTemplateBody(panel()), dashboardTemplateBody(dashboard())]) {
    const spec = templateValidationSpec(body);
    assert.ok(spec.panels.length > 0);
    assert.deepEqual(
      spec.panels.map((p) => p.query.sql),
      templatePanels(body).map((p) => p.query.sql),
      "every statement the server will guard is in the spec it guards",
    );
  }
});

test("summarize counts panels", () => {
  assert.equal(summarizeTemplate(panelTemplateBody(panel())), "1 panel");
  assert.equal(summarizeTemplate(dashboardTemplateBody(dashboard())), "2 panels");
});

/* -------------------------------------------------------------------------- */
/* Reading a list body                                                        */
/* -------------------------------------------------------------------------- */

test("a row whose body does not parse is dropped, not offered", () => {
  const templates = readTemplates({
    templates: [
      {
        id: "1",
        kind: "panel",
        name: "Good",
        origin: "workspace",
        body: { kind: "panel", panel: panel() },
      },
      { id: "2", kind: "panel", name: "Bad", body: { kind: "panel", panel: {} } },
      { id: "3", kind: "panel", name: "Missing body" },
    ],
  });
  assert.deepEqual(
    templates.map((t) => t.id),
    ["1"],
  );
});

test("an unrecognised origin reads as a workspace template, never as built-in", () => {
  const [template] = readTemplates({
    templates: [
      {
        id: "1",
        kind: "dashboard",
        name: "X",
        origin: "something-else",
        body: { kind: "dashboard", dashboard: dashboard() },
      },
    ],
  });
  assert.equal(template.origin, "workspace");
});

test("a body that is not a list reads as no templates", () => {
  assert.deepEqual(readTemplates({ templates: "all of them" }), []);
  assert.deepEqual(readTemplates(null), []);
});
