import { expect, test } from "@playwright/test";
import { STUB_CHAT_REPLY } from "../src/lib/ai/stub";
import { SPEC_VERSION } from "../src/lib/ir";
import { PG_PORT, storageStatePath } from "./env";
import { DEMO_DASHBOARD, dashboardId, waitForPanels } from "./support/app";

/*
 * The flows around the core journey (#88): Explore, dashboard chat, a source
 * removed out from under a dashboard, and a viewer kept out of the editor.
 */

test("explore answers a question with a guarded query", async ({ page }) => {
  await page.goto("/explore");
  await page.getByRole("combobox", { name: "Data source" }).click();
  await page.getByRole("option", { name: "Demo TimescaleDB metrics" }).click();
  await page.locator("#prompt").fill("Which service is busiest?");
  await page.getByRole("button", { name: "Explore" }).click();
  // The recorded panel's SQL ran on the server: real rows, real services.
  const table = page.getByRole("region", { name: "Requests by service, table" });
  await expect(table.getByRole("cell", { name: "api", exact: true })).toBeVisible();
});

test("dashboard chat answers in the panel", async ({ page, request }) => {
  await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
  await page.getByRole("button", { name: "Ask about this dashboard" }).click();
  const chat = page
    .getByRole("complementary", { name: "Dashboard chat" })
    .or(page.locator('[aria-label="Dashboard chat"]'));
  await chat.getByRole("textbox", { name: "Message" }).fill("What is on this dashboard?");
  await chat.getByRole("button", { name: "Send" }).click();
  await expect(chat.getByText(STUB_CHAT_REPLY)).toBeVisible();
});

test("a deleted source tombstones the panels that used it", async ({ page, request }) => {
  const id = `e2e-gone-${Date.now().toString(36)}`;
  const name = `Doomed ${id}`;
  const created = await request.post("/api/sources", {
    data: {
      workspaceId: "demo",
      id,
      name,
      secretRef: "TS_METRICS",
      config: {
        host: "localhost",
        port: PG_PORT,
        database: "holotable",
        schema: "metrics",
        ssl: false,
        tables: [
          {
            name: "http_requests",
            timeField: "ts",
            columns: [
              { name: "ts", type: "timestamp with time zone" },
              { name: "route", type: "text" },
            ],
          },
        ],
      },
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const dash = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: SPEC_VERSION,
        title: `Uses ${id}`,
        timeRange: { from: "now-1h", to: "now" },
        refreshIntervalMs: 2000,
        panels: [
          {
            id: "routes",
            title: "Requests by route",
            viz: "table",
            query: {
              sourceId: id,
              sql: "SELECT route, count(*) AS n FROM http_requests GROUP BY route",
            },
            layout: { x: 0, y: 0, w: 12, h: 4 },
          },
        ],
      },
    },
  });
  expect(dash.ok(), await dash.text()).toBe(true);
  const { dashboard } = (await dash.json()) as { dashboard: { id: string } };

  await page.goto("/data-sources");
  await page.getByRole("button", { name: `Delete ${name}` }).click();
  const confirm = page.getByRole("dialog", { name: `Delete ${name}?` });
  await confirm.getByRole("button", { name: /^Delete/ }).click();
  await expect(page.locator(`#source-${id}`)).toBeHidden();

  await page.goto(`/dashboards/${dashboard.id}`);
  await expect(
    page.getByText("This panel's data source has been removed."),
  ).toBeVisible();
});

test.describe("as a viewer", () => {
  test.use({ storageState: storageStatePath("viewer") });

  test("the dashboard opens, the editor does not", async ({ page, request }) => {
    const id = await dashboardId(request, DEMO_DASHBOARD);
    await page.goto(`/dashboards/${id}`);
    await waitForPanels(page);
    await expect(page.getByRole("link", { name: "Edit" })).toHaveCount(0);

    // `notFound()` from the page: indistinguishable from a dashboard that
    // does not exist, by design. (Streamed, so the status line is already 200.)
    await page.goto(`/dashboards/${id}/edit`);
    await expect(
      page.getByRole("heading", { name: "This page could not be found." }),
    ).toBeVisible();
    await expect(page.locator("#p-title")).toHaveCount(0);
  });
});
