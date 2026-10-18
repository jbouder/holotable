import { type APIRequestContext, expect, test } from "@playwright/test";
import { LOKI_URL } from "./env";
import { expectNoA11yViolations, setAppearance, type Theme } from "./support/a11y";
import {
  discoverLokiLabels,
  expectSource,
  LOKI_APP_VALUES,
  openLokiForm,
  unique,
  waitForPanels,
} from "./support/app";

/*
 * A Loki source end to end (#567), against the stack's real Loki, which
 * e2e/prepare.ts filled with labeled JSON lines: register it through the
 * form, discover and allowlist its labels, test it, refresh it, generate a
 * dashboard with the recorded model (a logs panel and a rate panel, #564),
 * watch both render from the endpoint's rows, and read the plan. The axe
 * scans cover the form, the test report, and a dashboard of LogQL panels in
 * both themes.
 */

test("a Loki source: form, discovery, test, generate, render, plan", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await setAppearance(page, "dark");
  const sourceId = `e2e-loki-${unique()}`;
  const sourceName = `E2E Loki ${sourceId}`;

  await test.step("register it through the form, discovering its labels", async () => {
    const dialog = await openLokiForm(page);
    await dialog.getByLabel("Source id").fill(sourceId);
    await dialog.getByLabel("Name").fill(sourceName);
    // Ticks `app`, which asks the endpoint for its values over GET.
    await discoverLokiLabels(dialog);
    const search = dialog.getByLabel("Search the discovered labels");
    await search.fill("env");
    await dialog.getByRole("checkbox", { name: "env", exact: true }).check();
    await expect(dialog.getByText("e2e", { exact: true })).toBeVisible();
    await search.fill("");
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    const row = page.locator(`#source-${sourceId}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(LOKI_URL);
    // Discovered, never refreshed: the health says so.
    await expect(row).toContainText("Never refreshed");

    const saved = await request.get(`/api/sources/${sourceId}`);
    expect(saved.ok(), await saved.text()).toBe(true);
    const body = (await saved.json()) as { source: { config: unknown } };
    expect(body.source.config).toMatchObject({
      kind: "loki",
      labels: [
        { name: "app", values: LOKI_APP_VALUES },
        { name: "env", values: ["e2e"] },
      ],
    });
  });

  await test.step("test it and refresh its catalog", async () => {
    await page.getByRole("button", { name: `Test ${sourceName}` }).click();
    const report = page.getByRole("region", { name: `Test result for ${sourceName}` });
    await expect(report).toBeVisible();
    await expect(report.getByText(/Connected/).first()).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: `Refresh ${sourceName}` }).click();
    const refresh = page.getByRole("dialog");
    await refresh
      .getByRole("button", { name: /^(Mark as refreshed|Apply changes)$/ })
      .click();
    await expect(refresh).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toContainText("Catalog fresh");
  });

  await test.step("its kind is fixed: editing opens the Loki form, as saved", async () => {
    await page.getByRole("button", { name: `Edit ${sourceName}` }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${sourceName}` });
    await expect(edit.getByLabel("URL")).toHaveValue(LOKI_URL);
    await expect(edit.getByText(LOKI_APP_VALUES.join(", "))).toBeVisible();
    await edit.getByRole("button", { name: "Cancel" }).click();
    await expect(edit).toBeHidden();
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
    await page
      .getByLabel("Describe the dashboard")
      .fill("Errors from the API in the last hour, and the error rate by route");
    await page.getByRole("button", { name: "Generate" }).click();
    // The recorded LogQL answer (src/lib/ai/stub.ts), on `app="api"`.
    const preview = page.getByRole("region", { name: "Dashboard preview" });
    await expect(preview.getByText("Error rate by route").first()).toBeVisible();
    await preview.getByRole("button", { name: "Save dashboard" }).click();
    const save = page.getByRole("dialog", { name: "Save dashboard" });
    await save.getByRole("button", { name: "Save dashboard" }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
    dashboardUrl = page.url();
  });

  await test.step("the logs panel and the rate panel render from the endpoint", async () => {
    await page.goto(dashboardUrl);
    await waitForPanels(page);
    const lines = page.locator('[data-panel-id="errors"]');
    await expect(lines).toHaveAttribute("data-status", "live", { timeout: 30_000 });
    // A pushed error line, parsed by `| json`, its level label colored.
    await expect(lines.getByText(/request\.failed/).first()).toBeVisible();
    const rate = page.locator('[data-panel-id="error-rate"]');
    await expect(rate.locator("[data-echarts-canvas] canvas")).toBeVisible();
    await expect(rate).toHaveAttribute("data-status", "live", { timeout: 30_000 });
  });

  await test.step("the query dialog shows what runs", async () => {
    const panel = page.locator('[data-panel-id="error-rate"]');
    await panel.hover();
    await panel.getByRole("button", { name: "Actions for Error rate by route" }).click();
    await page.getByRole("menuitem", { name: "Show query" }).click();
    const dialog = page.getByRole("dialog", { name: "Query" });
    await expect(dialog.getByText("LogQL", { exact: true })).toBeVisible();
    await dialog.getByRole("button", { name: "Show" }).click();
    await expect(
      dialog.getByText("Expression sent to /loki/api/v1/query_range"),
    ).toBeVisible();
  });

  const removed = await request.delete(`/api/sources/${sourceId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
});

/**
 * A Loki source on the stack's Loki and a dashboard of the two LogQL shapes,
 * a log query on a logs panel and a metric query on a line, for the scans.
 */
async function createLokiDashboard(request: APIRequestContext) {
  const sourceId = "e2e-loki-view";
  const listed = await request.get("/api/sources?workspaceId=demo");
  expect(listed.ok(), await listed.text()).toBe(true);
  const { sources } = (await listed.json()) as { sources: { id: string }[] };
  if (!sources.some((s) => s.id === sourceId)) {
    const source = await request.post("/api/sources", {
      data: {
        workspaceId: "demo",
        id: sourceId,
        name: "Loki e2e (view)",
        config: {
          kind: "loki",
          url: LOKI_URL,
          auth: "none",
          labels: [{ name: "app", values: LOKI_APP_VALUES }],
        },
      },
    });
    // Both schemes' tests may create it at once (#610); one create wins.
    if (source.status() !== 201) await expectSource(request, sourceId);
  }
  const res = await request.post("/api/dashboards", {
    data: {
      spec: {
        specVersion: 1,
        title: `Loki lines ${unique()}`,
        timeRange: { from: "now-1h", to: "now" },
        refreshIntervalMs: 30_000,
        panels: [
          {
            id: "lines",
            title: "Worker lines",
            viz: "logs",
            query: { sourceId, logql: '{app="worker"} | json' },
            options: { level: "level", limit: 50 },
            layout: { x: 0, y: 0, w: 12, h: 5 },
          },
          {
            id: "by-route",
            title: "Lines by route",
            viz: "line",
            query: {
              sourceId,
              logql: 'sum by (route) (count_over_time({app="worker"} | json [5m]))',
            },
            layout: { x: 0, y: 5, w: 12, h: 4 },
          },
        ],
      },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return ((await res.json()) as { dashboard: { id: string } }).dashboard.id;
}

for (const theme of ["light", "dark"] as Theme[]) {
  test(`a dashboard of LogQL panels has no axe violations, ${theme}`, async ({
    page,
    request,
  }) => {
    await setAppearance(page, theme);
    await page.goto(`/dashboards/${await createLokiDashboard(request)}`);
    await waitForPanels(page);
    const lines = page.locator('[data-panel-id="lines"]');
    await expect(lines).toHaveAttribute("data-status", "live", { timeout: 30_000 });
    await expect(lines.getByText(/request\.completed/).first()).toBeVisible();
    await expect(page.locator('[data-panel-id="by-route"]')).toHaveAttribute(
      "data-status",
      "live",
      { timeout: 30_000 },
    );
    await expectNoA11yViolations(page);
  });
}
