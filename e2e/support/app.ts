import {
  expect,
  type APIRequestContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { LOKI_URL } from "../env";

/** Helpers shared by the specs. Nothing here signs in; the setup project did. */

/**
 * A suffix no other test is using: the time and a random part, so two tests
 * started in the same millisecond on two workers (#610) still differ. Every
 * record a test creates (a source id, a dashboard title) carries one, and no
 * test counts a shared list.
 */
export function unique(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** A seeded dashboard's id, by title (scripts/seed.ts). */
export async function dashboardId(request: APIRequestContext, title: string) {
  // By title, so the exact one comes before the copies tests make of it
  // (`copyDashboard`), however many earlier runs left on the first page.
  const res = await request.get(
    `/api/dashboards?q=${encodeURIComponent(title)}&sort=title`,
  );
  expect(res.ok(), `GET /api/dashboards answered ${res.status()}`).toBe(true);
  const body = (await res.json()) as { dashboards: { id: string; title: string }[] };
  const found = body.dashboards.find((d) => d.title === title);
  if (!found) throw new Error(`no dashboard titled "${title}"; did the seeder run?`);
  return found.id;
}

/** The seeded dashboard every read-only spec opens. */
export const DEMO_DASHBOARD = "Demo service health";

/**
 * A copy of a seeded dashboard, under a title of its own, for a test that
 * changes what is stored per dashboard (its chat, its share links): with
 * specs running in parallel (#610), the seeded one is everyone's.
 */
export async function copyDashboard(request: APIRequestContext, title: string) {
  const res = await request.get(`/api/dashboards/${await dashboardId(request, title)}`);
  expect(res.ok(), await res.text()).toBe(true);
  const { dashboard } = (await res.json()) as { dashboard: { spec: object } };
  const created = await request.post("/api/dashboards", {
    data: { spec: { ...dashboard.spec, title: `${title} ${unique()}` } },
  });
  expect(created.ok(), await created.text()).toBe(true);
  return ((await created.json()) as { dashboard: { id: string } }).dashboard.id;
}

/**
 * Wait for a live dashboard to have drawn: every panel's loading skeleton gone.
 * The stream never goes idle, so "network idle" is not a signal here.
 */
export async function waitForPanels(page: Page) {
  await expect(page.locator("[data-panel-id]").first()).toBeVisible();
  await expect(page.locator('[data-panel-id][data-status="loading"]')).toHaveCount(0);
}

/**
 * Two dashboards in the demo workspace, the first linking to the second
 * (#372): a link to it that sets `route`, a self link that sets `route` in
 * place, and a link to a dashboard that does not exist. Both declare `route`,
 * so the picks carry across.
 */
export async function createLinkedDashboards(request: APIRequestContext) {
  const stamp = unique();
  const variables = [
    { name: "route", type: "enum", values: ["/login", "/checkout", "/search"] },
  ];
  const panel = {
    id: "routes",
    title: "Requests by route",
    viz: "table",
    query: {
      sourceId: "ts-metrics",
      sql: "SELECT route, count(*) AS requests FROM http_requests WHERE route = :route GROUP BY route",
    },
    layout: { x: 0, y: 0, w: 12, h: 4 },
  };
  const create = async (title: string, links?: unknown[]) => {
    const res = await request.post("/api/dashboards", {
      data: {
        spec: {
          specVersion: 1,
          title,
          timeRange: { from: "now-1h", to: "now" },
          refreshIntervalMs: 2000,
          variables,
          panels: [{ ...panel, links }],
        },
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
  };
  const target = await create(`Drilldown target ${stamp}`);
  const source = await create(`Drilldown source ${stamp}`, [
    {
      title: "Checkout detail",
      dashboard: target,
      set: { route: { value: "/checkout" } },
    },
    { title: "Only search", set: { route: { value: "/search" } } },
    { title: "Retired dashboard", dashboard: "00000000-0000-4000-8000-000000000000" },
  ]);
  return { source, target };
}

/**
 * The service map twice (#682), as a directed graph and as a force graph,
 * each drawn as markers so it zooms and pans. Refreshed once a minute, so no
 * new rows redraw the picture while a test compares it.
 */
export async function createGraphDashboard(request: APIRequestContext) {
  const query = {
    sourceId: "ts-metrics",
    timeField: "period",
    sql: "SELECT time_bucket('5 minutes', ts) AS period, caller, callee, sum(requests) AS requests FROM service_calls GROUP BY period, caller, callee ORDER BY period",
  };
  const options = { source: "caller", target: "callee", value: "requests" };
  const res = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: 1,
        title: `Graphs ${unique()}`,
        timeRange: { from: "now-1h", to: "now" },
        refreshIntervalMs: 60_000,
        panels: [
          {
            id: "dag",
            title: "Calls, directed",
            viz: "graph",
            query,
            options: { ...options, layout: "dag", direction: "LR" },
            layout: { x: 0, y: 0, w: 6, h: 4 },
          },
          {
            id: "force",
            title: "Calls, force",
            viz: "graph",
            query,
            options: { ...options, layout: "force" },
            layout: { x: 6, y: 0, w: 6, h: 4 },
          },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
}

/**
 * A fleet dashboard whose pie of hosts drills into a host dashboard (#373).
 * The pie holds one host, so a click anywhere on it is a click on that slice.
 * With `withSelf`, the slice also offers a self link that filters the fleet
 * to the host, so a click lists both links instead of following one.
 */
export async function createDrilldownDashboards(
  request: APIRequestContext,
  { withSelf = false }: { withSelf?: boolean } = {},
) {
  const stamp = unique();
  const host = {
    name: "host",
    type: "query",
    query: {
      sourceId: "ts-system",
      sql: "SELECT DISTINCT host FROM system_metrics ORDER BY host",
    },
  };
  const create = async (title: string, panel: Record<string, unknown>) => {
    const res = await request.post("/api/dashboards", {
      data: {
        spec: {
          specVersion: 1,
          title,
          timeRange: { from: "now-1h", to: "now" },
          refreshIntervalMs: 2000,
          variables: [host],
          panels: [{ layout: { x: 0, y: 0, w: 12, h: 6 }, ...panel }],
        },
      },
    });
    expect(res.ok(), await res.text()).toBe(true);
    return ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
  };
  const target = await create(`Host detail ${stamp}`, {
    id: "cpu",
    title: "CPU",
    viz: "stat",
    query: {
      sourceId: "ts-system",
      sql: "SELECT avg(cpu_pct) AS cpu FROM system_metrics WHERE host = :host",
    },
  });
  const fleet = await create(`Fleet ${stamp}`, {
    id: "hosts",
    title: "Hosts",
    viz: "pie",
    query: {
      sourceId: "ts-system",
      sql: "SELECT host, count(*) AS samples FROM system_metrics GROUP BY host ORDER BY host LIMIT 1",
    },
    links: [
      { title: "Host detail", dashboard: target, set: { host: { column: "host" } } },
      ...(withSelf
        ? [{ title: "Filter to this host", set: { host: { series: true } } }]
        : []),
    ],
  });
  return { fleet, target };
}

/** Click the middle of a panel's chart: on a one-slice pie, the slice. */
export async function clickChart(page: Page, panelId: string) {
  const canvas = page.locator(
    `[data-panel-id="${panelId}"] [data-echarts-canvas] canvas`,
  );
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error("the chart has no box");
  // The pie sits a little below the middle, under its legend.
  await page.mouse.click(box.x + box.width / 2 + 10, box.y + box.height * 0.56);
}

/**
 * A Prometheus source and a dashboard with one PromQL panel on it (#388), for
 * the editor in PromQL mode. The URL is a public address literal the save
 * checks against SOURCE_URL_ALLOWLIST without resolving; nothing here needs
 * it to answer, because the editor's guard runs against the catalog.
 */
export async function createPromqlDashboard(request: APIRequestContext) {
  const stamp = unique();
  const sourceId = `e2e-promql-${stamp}`;
  const source = await request.post("/api/sources", {
    data: {
      workspaceId: "demo",
      id: sourceId,
      name: `PromQL ${stamp}`,
      config: {
        kind: "prometheus",
        url: "https://93.184.216.34",
        auth: "none",
        metrics: [
          { name: "up", type: "gauge", labels: ["instance", "job"] },
          {
            name: "http_requests_total",
            type: "counter",
            labels: ["code", "instance", "job"],
          },
        ],
      },
    },
  });
  expect(source.status(), await source.text()).toBe(201);
  const res = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: 1,
        title: `PromQL editor ${stamp}`,
        timeRange: { from: "now-1h", to: "now" },
        refreshIntervalMs: 30_000,
        panels: [
          {
            id: "rate",
            title: "Request rate",
            viz: "line",
            query: { sourceId, promql: "sum(rate(http_requests_total[5m]))" },
            layout: { x: 0, y: 0, w: 12, h: 6 },
          },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
}

/**
 * A Loki source and a dashboard with one LogQL logs panel on it (#565), for
 * the editor in LogQL mode. Like the PromQL one, nothing needs the URL to
 * answer: the editor's completion and guard run against the label catalog.
 */
export async function createLogqlDashboard(request: APIRequestContext) {
  const stamp = unique();
  // One source for both schemes' runs: each is another entry in the demo
  // workspace's source menus, which the chat journeys open.
  const sourceId = "e2e-logql";
  const listed = await request.get("/api/sources?workspaceId=demo");
  expect(listed.ok(), await listed.text()).toBe(true);
  const { sources } = (await listed.json()) as { sources: { id: string }[] };
  if (!sources.some((s) => s.id === sourceId)) {
    // Another worker may create it between the listing and here (#610),
    // which this create then loses; either way the source is there.
    const source = await request.post("/api/sources", {
      data: {
        workspaceId: "demo",
        id: sourceId,
        name: "LogQL e2e",
        config: {
          kind: "loki",
          url: "https://93.184.216.34",
          auth: "none",
          labels: [
            { name: "job", values: ["api", "web"] },
            { name: "level", values: ["info", "error"] },
          ],
        },
      },
    });
    if (source.status() !== 201) await expectSource(request, sourceId);
  }
  const res = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: 1,
        title: `LogQL editor ${stamp}`,
        timeRange: { from: "now-1h", to: "now" },
        refreshIntervalMs: 30_000,
        panels: [
          {
            id: "lines",
            title: "API lines",
            viz: "logs",
            query: { sourceId, logql: '{job="api"} |= "error"' },
            layout: { x: 0, y: 0, w: 12, h: 6 },
          },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
}

/**
 * Ask Explore (#416, #431) one question over the demo TimescaleDB source. The stub
 * draws the recorded "Requests by service" panel, whose SQL runs on the
 * server against the seeded rows, then answers with its recorded reply.
 */
export async function askChat(page: Page, question = "Which service is busiest?") {
  await page.goto("/explore");
  await page.getByRole("button", { name: /^Sources:/ }).click();
  const demo = page.getByRole("menuitemcheckbox", { name: /Demo TimescaleDB metrics/ });
  if ((await demo.getAttribute("aria-checked")) !== "true") await demo.click();
  await expect(demo).toHaveAttribute("aria-checked", "true");
  // The metrics source alone: the stub draws against the first one listed.
  const others = page
    .getByRole("menuitemcheckbox", { checked: true })
    .filter({ hasNotText: "Demo TimescaleDB metrics" });
  while ((await others.count()) > 0) await others.first().click();
  await page.keyboard.press("Escape");
  await page.getByRole("textbox", { name: "Message" }).fill(question);
  await page.keyboard.press("Enter");
}

/** That a source is in the demo workspace, whoever created it. */
export async function expectSource(request: APIRequestContext, sourceId: string) {
  const listed = await request.get("/api/sources?workspaceId=demo");
  expect(listed.ok(), await listed.text()).toBe(true);
  const { sources } = (await listed.json()) as { sources: { id: string }[] };
  expect(sources.map((s) => s.id)).toContain(sourceId);
}

/** A fresh read-only share link to a dashboard, as its absolute embed URL. */
export async function createShareLink(request: APIRequestContext, dashboard: string) {
  const res = await request.post(`/api/dashboards/${dashboard}/shares`, {
    data: { label: "e2e", expiresInDays: 1 },
  });
  expect(res.ok(), `POST shares answered ${res.status()}`).toBe(true);
  return ((await res.json()) as { url: string }).url;
}

/**
 * The `app` values e2e/prepare.ts pushes to the stack's Loki (#567), which is
 * what discovery answers with for that label.
 */
export const LOKI_APP_VALUES = ["api", "web", "worker"];

/**
 * Open the Add source dialog on the Loki form, with the stack's Loki filled
 * in (#567). Discovery asks that Loki for real: the labels and values are the
 * ones e2e/prepare.ts pushed.
 */
export async function openLokiForm(page: Page) {
  await page.goto("/data-sources");
  await page.getByRole("button", { name: "Add source" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add source" });
  await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
  await dialog.getByRole("radio", { name: "Loki (LogQL)" }).click();
  // Loopback, which the app's SOURCE_URL_ALLOWLIST names (e2e/env.ts).
  await dialog.getByLabel("URL").fill(LOKI_URL);
  await dialog.getByRole("combobox", { name: "Authentication" }).click();
  await page.getByRole("option", { name: "None (in-cluster endpoint)" }).click();
  return dialog;
}

/** Discover the endpoint's labels and tick `app`, which fetches its values. */
export async function discoverLokiLabels(dialog: Locator) {
  await dialog.getByRole("button", { name: "Discover labels" }).click();
  const search = dialog.getByLabel("Search the discovered labels");
  await search.fill("ap");
  await dialog.getByRole("checkbox", { name: "app", exact: true }).check();
  await expect(dialog.getByText(LOKI_APP_VALUES.join(", "))).toBeVisible();
  await search.fill("");
}
