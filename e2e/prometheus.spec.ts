import { expect, test } from "@playwright/test";
import { PROM_URL } from "./env";
import { expectNoA11yViolations, setAppearance } from "./support/a11y";
import { waitForPanels } from "./support/app";

/*
 * A Prometheus source end to end (#390), against the stack's real Prometheus,
 * which scrapes this app: register it through the form, discover and
 * allowlist two metrics, test it, refresh it, generate a dashboard with the
 * recorded model, watch a PromQL line render, brush a range, and read the
 * plan. A second test follows a `{ label }` drilldown on the seeded
 * Prometheus source. The axe scans cover the Prometheus form and the test
 * report.
 */

// Motion reduced, as for every axe scan: the test report fades in, and a
// contrast measured halfway through the fade is not the one that lands.
test.beforeEach(async ({ page }) => {
  await setAppearance(page, "dark");
});

/** What the recorded PromQL dashboard reads (src/lib/ai/stub.ts). */
const METRICS = [
  "holotable_query_duration_seconds_count",
  "holotable_query_duration_seconds_bucket",
  "holotable_pollers_active",
];

test("a Prometheus source: form, discovery, test, generate, render, brush, plan", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const sourceId = `e2e-prom-${Date.now().toString(36)}`;
  const sourceName = `E2E Prometheus ${sourceId}`;

  await test.step("register it through the form, discovering its metrics", async () => {
    await page.goto("/data-sources");
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
    await dialog.getByRole("combobox", { name: "Kind" }).click();
    await page.getByRole("option", { name: "Prometheus (PromQL)" }).click();
    await dialog.getByLabel("Source id").fill(sourceId);
    await dialog.getByLabel("Name").fill(sourceName);
    await dialog.getByLabel("URL").fill(PROM_URL);
    await dialog.getByRole("combobox", { name: "Authentication" }).click();
    await page.getByRole("option", { name: "None (in-cluster endpoint)" }).click();
    await dialog.getByRole("button", { name: "Discover metrics" }).click();
    const search = dialog.getByLabel("Search the discovered metrics");
    // The app has run queries by now, so the histogram has series.
    for (const metric of METRICS) {
      await search.fill(metric);
      await dialog.getByRole("checkbox", { name: new RegExp(`^${metric}\\b`) }).check();
    }
    // Picking a metric asks the endpoint for its labels.
    await expect(
      dialog.getByText(/le, outcome, source|outcome, source/).first(),
    ).toBeVisible();
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toBeVisible();
  });

  await test.step("test it and refresh its catalog", async () => {
    await page.getByRole("button", { name: `Test ${sourceName}` }).click();
    const report = page.getByRole("region", { name: `Test result for ${sourceName}` });
    await expect(report).toBeVisible();
    await expect(report.getByText(/Prometheus/).first()).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: `Refresh ${sourceName}` }).click();
    const refresh = page.getByRole("dialog");
    await refresh
      .getByRole("button", { name: /^(Mark as refreshed|Apply changes)$/ })
      .click();
    await expect(refresh).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toContainText("Catalog fresh");
  });

  let dashboardUrl = "";
  await test.step("generate a dashboard against it and save it", async () => {
    await page.goto("/dashboards/new");
    await page.getByRole("button", { name: /^Data source:/ }).click();
    const sources = page.getByRole("menu");
    const pick = sources.getByRole("menuitemcheckbox", { name: new RegExp(sourceName) });
    if ((await pick.getAttribute("aria-checked")) !== "true") await pick.click();
    await expect(pick).toHaveAttribute("aria-checked", "true");
    const others = sources
      .getByRole("menuitemcheckbox", { checked: true })
      .filter({ hasNotText: sourceName });
    while ((await others.count()) > 0) await others.first().click();
    await page.keyboard.press("Escape");
    await page.getByLabel("Describe the dashboard").fill("Query load");
    await page.getByRole("button", { name: "Generate" }).click();
    // The recorded PromQL answer (src/lib/ai/stub.ts).
    const preview = page.getByRole("region", { name: "Dashboard preview" });
    await expect(preview.getByText("Holotable query load").first()).toBeVisible();
    await preview.getByRole("button", { name: "Save dashboard" }).click();
    const save = page.getByRole("dialog", { name: "Save dashboard" });
    await save.getByRole("button", { name: "Save dashboard" }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
    dashboardUrl = page.url();
  });

  await test.step("a PromQL line chart renders from the endpoint's rows", async () => {
    await page.goto(dashboardUrl);
    await waitForPanels(page);
    const line = page.locator('[data-panel-id="query-rate"]');
    await expect(line.locator("[data-echarts-canvas] canvas")).toBeVisible();
    await expect(line).toHaveAttribute("data-status", "live", { timeout: 30_000 });
  });

  await test.step("brushing the line selects that stretch as the window", async () => {
    const canvas = page.locator(
      '[data-panel-id="query-rate"] [data-echarts-canvas] canvas',
    );
    const box = await canvas.boundingBox();
    if (!box) throw new Error("the chart has no box");
    const y = box.y + box.height * 0.5;
    await page.mouse.move(box.x + box.width * 0.3, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, y, { steps: 8 });
    await page.mouse.move(box.x + box.width * 0.85, y, { steps: 8 });
    await page.mouse.up();
    // A brush names a stretch of history: an absolute window in the URL.
    await expect(page).toHaveURL(/[?&]from=\d{4}-\d{2}-\d{2}T/);
  });

  await test.step("the query dialog shows what runs", async () => {
    const panel = page.locator('[data-panel-id="query-rate"]');
    await panel.hover();
    await panel
      .getByRole("button", { name: "Actions for Queries per second by source" })
      .click();
    await page.getByRole("menuitem", { name: "Show query" }).click();
    const dialog = page.getByRole("dialog", { name: "Query" });
    await expect(dialog.getByText("PromQL", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Show" }).click();
    await expect(
      dialog.getByText("Expression sent to /api/v1/query_range"),
    ).toBeVisible();
    await expect(
      dialog.getByText(/points · \d+ s · [\d.]+ MiB · \d+ series/),
    ).toBeVisible();
  });

  const removed = await request.delete(`/api/sources/${sourceId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
});

test("clicking a PromQL series' label filters the dashboard to it (#388, #390)", async ({
  page,
  request,
}) => {
  const stamp = Date.now().toString(36);
  const created = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: 1,
        title: `Prometheus targets ${stamp}`,
        timeRange: { from: "now-15m", to: "now" },
        refreshIntervalMs: 5000,
        variables: [
          {
            name: "instance",
            type: "query",
            query: { sourceId: "prometheus-self", label: "instance" },
          },
        ],
        panels: [
          {
            id: "up",
            title: "Scrape up",
            viz: "line",
            // One series, the app's own target, so the row is that series.
            query: {
              sourceId: "prometheus-self",
              promql: 'max by (instance) (up{job="holotable"})',
            },
            links: [
              {
                title: "Filter to this instance",
                set: { instance: { label: "instance" } },
              },
            ],
            layout: { x: 0, y: 0, w: 12, h: 6 },
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { dashboard: { id: string } }).dashboard.id;

  await page.goto(`/dashboards/${id}`);
  await waitForPanels(page);
  // The keyboard reaches a datum link through the chart's data table.
  const rowLink = page
    .locator('[data-panel-id="up"]')
    .getByRole("button", { name: /: Filter to this instance$/ })
    .first();
  await rowLink.focus();
  await page.keyboard.press("Enter");
  await expect
    .poll(() => new URL(page.url()).searchParams.get("var-instance"))
    .toMatch(/^host\.docker\.internal:\d+$/);
});
