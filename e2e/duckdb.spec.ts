import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, setAppearance } from "./support/a11y";
import { dashboardId, waitForPanels } from "./support/app";

/*
 * A DuckDB source end to end (#573), against the Parquet file `prepare.ts`
 * writes under the stack's `DUCKDB_SOURCES_DIR`: register it through the
 * form, picking the path from the server's listing, discover and allowlist
 * its table, test it (engine, layout, lock), refresh it, then generate a
 * dashboard with the recorded model and watch a panel render from the file.
 * The axe scans cover the form, the picker and the test report; the form and
 * picker are also scanned in every theme by a11y.spec.ts.
 *
 * The seeder also writes the files demo under the same root (#574) and seeds
 * the "Demo files" dashboard over it, which the last test opens.
 */

test.beforeEach(async ({ page }) => {
  await setAppearance(page, "dark");
});

test("a DuckDB source: path picker, discovery, test, generate, render", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const sourceId = `e2e-duck-${Date.now().toString(36)}`;
  const sourceName = `E2E DuckDB ${sourceId}`;

  await test.step("register it through the form, picking the path", async () => {
    await page.goto("/data-sources");
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
    await dialog.getByRole("radio", { name: "DuckDB (files)" }).click();
    await dialog.getByLabel("Source id").fill(sourceId);
    await dialog.getByLabel("Name").fill(sourceName);
    // The picker lists what is directly under the root, by name.
    await dialog.getByRole("combobox", { name: "Path" }).click();
    const option = page.getByRole("option", { name: /requests/ });
    await expect(option).toBeVisible();
    await expectNoA11yViolations(page);
    await option.click();
    await expect(dialog.getByRole("combobox", { name: "Path" })).toHaveValue("requests");

    await dialog.getByRole("button", { name: "Discover tables" }).click();
    await dialog.getByRole("checkbox", { name: /^http_requests\b/ }).check();
    await expect(dialog.getByLabel("Time column")).toBeVisible();
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toBeVisible();
  });

  await test.step("no path reaches someone who cannot manage it", async () => {
    const listing = await request.get("/api/sources?workspaceId=demo");
    expect(listing.ok()).toBe(true);
    const body = await listing.json();
    const row = body.sources.find((s: { id: string }) => s.id === sourceId);
    // The admin's own record names its relative path; the listing never does.
    expect(row?.config?.path).toBe("requests");
    const paths = await request.get("/api/sources/duckdb/paths?workspaceId=demo");
    const menu = await paths.json();
    expect(menu.ok).toBe(true);
    for (const entry of menu.paths) {
      expect(Object.keys(entry).sort()).toEqual(["layout", "name"]);
      expect(entry.name).not.toContain("/");
    }
  });

  await test.step("test it and refresh its catalog", async () => {
    await page.getByRole("button", { name: `Test ${sourceName}` }).click();
    const report = page.getByRole("region", { name: `Test result for ${sourceName}` });
    await expect(report).toBeVisible();
    await expect(report.getByText(/^DuckDB \d/)).toBeVisible();
    await expect(report.getByText("a directory of Parquet and CSV files")).toBeVisible();
    await expect(report.getByText(/^Locked:/)).toBeVisible();
    await expectNoA11yViolations(page);

    await page.getByRole("button", { name: `Refresh ${sourceName}` }).click();
    const refresh = page.getByRole("dialog");
    await refresh
      .getByRole("button", { name: /^(Mark as refreshed|Apply changes)$/ })
      .click();
    await expect(refresh).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toContainText("Catalog fresh");
  });

  await test.step("its edit form opens, as saved", async () => {
    await page.getByRole("button", { name: `Edit ${sourceName}` }).click();
    const edit = page.getByRole("dialog", { name: `Edit ${sourceName}` });
    await expect(edit.getByRole("combobox", { name: "Path" })).toHaveValue("requests");
    await expect(edit.getByRole("checkbox", { name: /^http_requests\b/ })).toBeChecked();
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
    await page.getByLabel("Describe the dashboard").fill("Request log");
    await page.getByRole("button", { name: "Generate" }).click();
    // The recorded DuckDB answer (src/lib/ai/stub.ts).
    const preview = page.getByRole("region", { name: "Dashboard preview" });
    await expect(preview.getByText("Request log").first()).toBeVisible();
    await preview.getByRole("button", { name: "Save dashboard" }).click();
    const save = page.getByRole("dialog", { name: "Save dashboard" });
    await save.getByRole("button", { name: "Save dashboard" }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
    dashboardUrl = page.url();
  });

  await test.step("a line chart renders from the file's rows", async () => {
    await page.goto(dashboardUrl);
    await waitForPanels(page);
    const line = page.locator('[data-panel-id="requests"]');
    await expect(line.locator("[data-echarts-canvas] canvas")).toBeVisible();
    await expect(line).toHaveAttribute("data-status", "live", { timeout: 30_000 });
  });

  const id = dashboardUrl.split("/").at(-1);
  if (id) await request.delete(`/api/dashboards/${id}`);
  const removed = await request.delete(`/api/sources/${sourceId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
});

test("the seeded Demo files dashboard renders from its Parquet and CSV files", async ({
  page,
  request,
}) => {
  await page.goto(`/dashboards/${await dashboardId(request, "Demo files")}`);
  await waitForPanels(page);
  // A panel per file: requests by minute (time_bucket), revenue by day
  // (date_trunc), and the requests file joined to the CSV inventory.
  for (const id of ["rpm", "traffic", "revenue-daily", "requests-by-region"]) {
    await expect(page.locator(`[data-panel-id="${id}"]`)).toHaveAttribute(
      "data-status",
      "live",
      { timeout: 30_000 },
    );
  }
  const table = page.locator('[data-panel-id="revenue-by-region"]');
  await expect(table.getByRole("cell", { name: "us-east" })).toBeVisible();
  await expect(page.locator('[data-panel-id][data-status="error"]')).toHaveCount(0);
  await expectNoA11yViolations(page);
});
