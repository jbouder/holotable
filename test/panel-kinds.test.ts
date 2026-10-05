import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";
import { renderPanels, resolveChatSources } from "@/lib/ai/chat";
import type { Identity } from "@/lib/auth/claims";
import { chatSuggestions, matchingPanels } from "@/lib/chat-history";
import { referencedSourceIds, remapSourceIds } from "@/lib/dashboard-export";
import { resolveAndValidateDashboard } from "@/lib/dashboard-service";
import { type Dashboard, ExplorePanel, hasQuery, Panel } from "@/lib/ir";
import { upgradeSpec } from "@/lib/ir/upgrade";
import { createLogger, setLogger } from "@/lib/log";
import { diffPanels } from "@/lib/panel-diff";
import { changePanelKind } from "@/lib/panel-kind-change";
import { duplicatePanel } from "@/lib/panel-list";
import { missingSourceIds, panelsUsingSource, repointPanels } from "@/lib/panel-repoint";
import { TEXT_CONTENT_MAX } from "@/lib/panels/kinds/text";
import { thresholdColor } from "@/lib/panels/thresholds";
import {
  DashboardPoller,
  type PanelExecutor,
  type PollerEvent,
} from "@/lib/poller/registry";
import type { SourceRecord } from "@/lib/registry";
import { retargetTemplate, templateSourceIds } from "@/lib/templates";

/*
 * The three kinds of M11 (#200 gauge, #201 state timeline, #202 text) as the
 * IR sees them, and every consumer of `panel.query` holding up against a
 * panel that has none.
 */

const LAYOUT = { x: 0, y: 0, w: 6, h: 4 };
const QUERY = { sourceId: "src-1", sql: "SELECT ts, v FROM m", timeField: "ts" };

const gauge = (options?: unknown) => ({
  id: "g",
  title: "CPU",
  viz: "gauge",
  query: QUERY,
  ...(options === undefined ? {} : { options }),
  layout: LAYOUT,
});
const text = (content: unknown = "## Runbook") => ({
  id: "t",
  title: "About",
  viz: "text",
  options: { content },
  layout: LAYOUT,
});
const line = (id = "l", sourceId = "src-1") => ({
  id,
  title: "Requests",
  viz: "line",
  query: { ...QUERY, sourceId },
  layout: LAYOUT,
});

function issues(input: unknown): string[] {
  const r = Panel.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
}

/* -------------------------------------------------------------------------- */
/* The IR                                                                     */
/* -------------------------------------------------------------------------- */

test("a gauge takes its own options, and they are validated", () => {
  assert.deepEqual(issues(gauge()), []);
  assert.deepEqual(
    issues(
      gauge({
        variant: "bar",
        value: "cpu",
        min: 0,
        max: "capacity",
        thresholds: [
          { value: 70, color: "warning" },
          { value: 90, color: "danger" },
        ],
      }),
    ),
    [],
  );
  assert.match(issues(gauge({ min: 10, max: 5 })).join(), /min must be below max/);
  assert.match(
    issues(
      gauge({
        thresholds: [
          { value: 90, color: "danger" },
          { value: 70, color: "warning" },
        ],
      }),
    ).join(),
    /ascending/,
  );
  assert.match(issues(gauge({ variant: "needle" })).join(), /options/);
  assert.match(issues(gauge({ colour: "red" })).join(), /options/);
});

test("a color is a token, never a raw color (invariant 13)", () => {
  for (const color of ["#ff0000", "red", "oklch(0.6 0.2 20)"]) {
    assert.notDeepEqual(issues(gauge({ thresholds: [{ value: 0, color }] })), [], color);
  }
});

test("options belong to their kind", () => {
  assert.match(
    issues({ ...line(), viz: "heatmap", options: { legend: "top" } }).join(),
    /a heatmap panel takes no options/,
  );
  assert.match(
    issues({ ...line(), options: { variant: "bar" } }).join(),
    /variant/,
    "a gauge's options on a line",
  );
  assert.match(
    issues({ ...gauge(), options: { content: "hi" } }).join(),
    /options/,
    "a text panel's options on a gauge",
  );
});

test("a state timeline needs its time field, and a state is colored once", () => {
  const timeline = (query: unknown, options?: unknown) => ({
    id: "s",
    title: "Status",
    viz: "state-timeline",
    query,
    ...(options === undefined ? {} : { options }),
    layout: LAYOUT,
  });
  assert.deepEqual(issues(timeline(QUERY)), []);
  assert.match(
    issues(timeline({ sourceId: "s", sql: "SELECT 1" })).join(),
    /query\.timeField: a state-timeline panel needs "query.timeField"/,
  );
  assert.match(
    issues(
      timeline(QUERY, {
        states: [
          { state: "up", color: "success" },
          { state: "up", color: "danger" },
        ],
      }),
    ).join(),
    /given a color twice/,
  );
});

test("a text panel carries content and no query, and its content is capped", () => {
  assert.deepEqual(issues(text()), []);
  assert.match(
    issues({ ...text(), query: QUERY }).join(),
    /runs no query; remove "query"/,
  );
  assert.notDeepEqual(issues({ ...text(), options: undefined }), []);
  assert.notDeepEqual(issues(text("")), []);
  assert.deepEqual(issues(text("x".repeat(TEXT_CONTENT_MAX))), []);
  assert.notDeepEqual(issues(text("x".repeat(TEXT_CONTENT_MAX + 1))), []);
  // Every other kind still needs its query.
  const { query: _, ...noQuery } = line();
  assert.match(issues(noQuery).join(), /a line panel needs a "query"/);
});

test("a spec saved before these kinds existed loads unchanged", () => {
  const spec = upgradeSpec({
    title: "old",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 30_000,
    panels: [line()],
  });
  assert.deepEqual(spec.panels[0], line());
});

test("explore answers from data, so a text panel is not an answer", () => {
  assert.equal(ExplorePanel.safeParse(line()).success, true);
  assert.equal(ExplorePanel.safeParse(text()).success, false);
});

test("a value takes the color of the last step at or below it", () => {
  const steps = [
    { value: 0, color: "success" as const },
    { value: 70, color: "warning" as const },
    { value: 90, color: "danger" as const },
  ];
  assert.equal(thresholdColor(steps, -5), undefined);
  assert.equal(thresholdColor(steps, 0), "success");
  assert.equal(thresholdColor(steps, 89.9), "warning");
  assert.equal(thresholdColor(steps, 90), "danger");
  assert.equal(thresholdColor(undefined, 50), undefined);
});

/* -------------------------------------------------------------------------- */
/* Every consumer of panel.query, with a panel that has none (#202)           */
/* -------------------------------------------------------------------------- */

const TEXT = Panel.parse(text());
const LINE = Panel.parse(line());
const DASHBOARD: Dashboard = {
  specVersion: 1,
  title: "d",
  timeRange: { from: "now-1h", to: "now" },
  refreshIntervalMs: 30_000,
  panels: [TEXT, LINE],
};

test("hasQuery tells them apart", () => {
  assert.equal(hasQuery(TEXT), false);
  assert.equal(hasQuery(LINE), true);
});

function source(id: string, workspaceId = "ws"): SourceRecord {
  return {
    id,
    workspaceId,
    name: id,
    kind: "timescaledb",
    config: {
      host: "localhost",
      port: 5432,
      database: "d",
      schema: "public",
      ssl: false,
      tables: [
        {
          name: "m",
          columns: [
            { name: "ts", type: "timestamptz" },
            { name: "v", type: "double precision" },
          ],
        },
      ],
    },
    secretRef: "TS",
    catalogRefreshedAt: new Date().toISOString(),
    catalogMissingTables: [],
    createdBy: "o",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tombstonedAt: null,
  } as SourceRecord;
}

test("saving: a text panel is skipped, and a dashboard of only text is refused", async () => {
  const looked: string[] = [];
  const getSource = async (id: string) => {
    looked.push(id);
    return source(id);
  };
  const { workspaceId } = await resolveAndValidateDashboard(DASHBOARD, getSource);
  assert.equal(workspaceId, "ws");
  assert.deepEqual(looked, ["src-1"]);

  await assert.rejects(
    resolveAndValidateDashboard({ ...DASHBOARD, panels: [TEXT] }, getSource),
    /at least one panel with a query/,
  );
});

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  setLogger(createLogger({ level: "silent" }));
});
afterEach(() => {
  mock.timers.reset();
  setLogger(createLogger());
});

test("the poller never executes a text panel, and each tick says its window", async () => {
  const ran: string[] = [];
  const executor: PanelExecutor = async (panel) => {
    ran.push(panel.id);
    return [{ type: "panel", panelId: panel.id, mode: "replace", columns: [], rows: [] }];
  };
  const poller = new DashboardPoller("d-text", 1, "ws", DASHBOARD, {}, executor);
  const events: PollerEvent[] = [];
  const stop = poller.subscribe((e) => events.push(e));
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
  stop();

  assert.deepEqual(ran, ["l"]);
  const tick = events.find((e) => e.type === "tick");
  assert.ok(tick?.type === "tick");
  // `now-1h` → `now`, resolved on the server's clock.
  assert.deepEqual(tick.window, { from: 1_000_000 - 3_600_000, to: 1_000_000 });
  assert.equal(poller.retryPanel("t"), false);
});

test("re-pointing passes a text panel by", () => {
  assert.deepEqual(missingSourceIds([TEXT, LINE], []), ["src-1"]);
  assert.deepEqual(
    panelsUsingSource([TEXT, LINE], "src-1").map((p) => p.id),
    ["l"],
  );
  const moved = repointPanels([TEXT, LINE], { panelIds: ["t", "l"], sourceId: "src-2" });
  assert.deepEqual(moved[0], TEXT);
  assert.equal(moved[1].query?.sourceId, "src-2");
});

test("an export names no source for a text panel, and an import leaves it alone", () => {
  assert.deepEqual(referencedSourceIds(DASHBOARD), ["src-1"]);
  const remapped = remapSourceIds(DASHBOARD, { "src-1": "src-9" });
  assert.deepEqual(remapped.panels[0], TEXT);
  assert.equal(remapped.panels[1].query?.sourceId, "src-9");
});

test("templates: a text panel has no source to list or retarget", () => {
  const body = { kind: "dashboard" as const, dashboard: DASHBOARD };
  assert.deepEqual(templateSourceIds(body), ["src-1"]);
  const retargeted = retargetTemplate(body, "src-3");
  assert.ok(retargeted.kind === "dashboard");
  assert.deepEqual(retargeted.dashboard.panels[0], TEXT);
  assert.deepEqual(templateSourceIds({ kind: "panel", specVersion: 1, panel: TEXT }), []);
});

test("chat: a text panel is context, never a citation or a question", async () => {
  assert.deepEqual(matchingPanels([TEXT, LINE], "src-1", QUERY.sql), ["Requests"]);
  const prompt = renderPanels(DASHBOARD);
  assert.match(prompt, /panel "t" — About \(viz: text, runs no query\)/);
  assert.match(prompt, /text: ## Runbook/);
  assert.ok(chatSuggestions(DASHBOARD).every((q) => !q.includes("About")));

  const sources = await resolveChatSources({
    identity: {
      sub: "u",
      groups: ["/workspaces/ws/viewers"],
      platformAdmin: false,
      workspaces: [{ workspaceId: "ws", role: "viewer" }],
    } as unknown as Identity,
    dashboard: { ...DASHBOARD, panels: [TEXT] },
    getSource: async (id) => source(id),
  });
  assert.deepEqual(sources, []);
});

test("a text panel's diff is its Markdown, not SQL", () => {
  const diff = diffPanels(TEXT, { ...TEXT, options: { content: "## Runbook v2" } });
  assert.equal(diff.bodyLabel, "Text");
  assert.equal(diff.sql.changed, true);
  assert.equal(diffPanels(LINE, LINE).bodyLabel, "SQL");
});

test("duplicating a text panel copies its content and invents no query", () => {
  const copied = duplicatePanel([TEXT], "t");
  assert.ok(copied);
  const copy = copied.panels.find((p) => p.id === copied.id);
  assert.equal(copy?.query, undefined);
  assert.deepEqual(copy?.options, TEXT.options);
  assert.equal(Panel.safeParse(copy).success, true);
});

test("switching kinds moves only what the new kind needs", () => {
  const starter = () => ({ sourceId: "src-7", sql: "SELECT 1 AS value" });

  const toText = changePanelKind(LINE, "text", starter);
  assert.equal(toText.query, undefined);
  assert.match(String(toText.options?.content), /## Requests/);
  assert.equal(Panel.safeParse(toText).success, true);

  const back = changePanelKind(toText, "stat", starter);
  assert.deepEqual(back.query, starter());
  assert.equal(back.options, undefined);
  assert.equal(Panel.safeParse(back).success, true);

  const g = Panel.parse(gauge({ variant: "bar", min: 0, max: 50 }));
  // The same query, drawn as a pie: the gauge's options are not the pie's.
  const pie = changePanelKind(g, "pie", starter);
  assert.deepEqual(pie.query, g.query);
  assert.equal(pie.options, undefined);
  // Options the new kind accepts are kept.
  assert.deepEqual(changePanelKind(g, "gauge", starter).options, g.options);
});
