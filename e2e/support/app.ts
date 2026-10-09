import { expect, type APIRequestContext, type Page } from "@playwright/test";

/** Helpers shared by the specs. Nothing here signs in; the setup project did. */

/** A seeded dashboard's id, by title (scripts/seed.ts). */
export async function dashboardId(request: APIRequestContext, title: string) {
  const res = await request.get(`/api/dashboards?q=${encodeURIComponent(title)}`);
  expect(res.ok(), `GET /api/dashboards answered ${res.status()}`).toBe(true);
  const body = (await res.json()) as { dashboards: { id: string; title: string }[] };
  const found = body.dashboards.find((d) => d.title === title);
  if (!found) throw new Error(`no dashboard titled "${title}"; did the seeder run?`);
  return found.id;
}

/** The seeded dashboard every read-only spec opens. */
export const DEMO_DASHBOARD = "Demo service health";

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
  const stamp = Date.now().toString(36);
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
 * A fleet dashboard whose pie of hosts drills into a host dashboard (#373).
 * The pie holds one host, so a click anywhere on it is a click on that slice.
 * With `withSelf`, the slice also offers a self link that filters the fleet
 * to the host, so a click lists both links instead of following one.
 */
export async function createDrilldownDashboards(
  request: APIRequestContext,
  { withSelf = false }: { withSelf?: boolean } = {},
) {
  const stamp = Date.now().toString(36);
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
