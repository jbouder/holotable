import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, setAppearance } from "./support/a11y";
import { dashboardId, waitForPanels } from "./support/app";
import { DUCKDB_DIR } from "./env";

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
    await expect(
      report.getByText("a directory of Parquet, CSV and JSON files"),
    ).toBeVisible();
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

/*
 * Uploading CSV files from the browser (#595): the sample the app ships,
 * read from disk the way a person's file would be picked, uploaded with
 * progress, its table discovered and allowlisted, a dashboard generated over
 * it with the recorded model, and a panel rendered from the uploaded rows.
 * Then a file dropped on its Add files dialog (#604), reviewed and applied
 * as a new table through the catalog refresh, and queried.
 */
test("an uploaded CSV: progress, discovery, create, generate, render", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const sourceId = `e2e-upload-${Date.now().toString(36)}`;
  const sourceName = `E2E upload ${sourceId}`;
  const sample = readFileSync(
    join(process.cwd(), "public/samples/household-expenses.csv"),
  );

  await test.step("upload the sample and create a source over it", async () => {
    await page.goto("/data-sources");
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
    await dialog.getByRole("radio", { name: "Upload files" }).click();
    await dialog.getByLabel("Source id").fill(sourceId);
    await dialog.getByLabel("Name").fill(sourceName);
    // The form offers the samples by URL; the journey picks the CSV from
    // disk, as a person would (the JSON journey below takes its sample).
    await expect(
      dialog.getByRole("button", { name: "household expenses" }),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "workouts" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "home energy" })).toBeVisible();
    await dialog.getByLabel("Files", { exact: true }).setInputFiles({
      name: "household-expenses.csv",
      mimeType: "text/csv",
      buffer: sample,
    });
    const bar = dialog.getByRole("progressbar", { name: "household-expenses.csv" });
    await expect(bar).toBeVisible();
    await dialog.getByRole("button", { name: "Upload", exact: true }).click();
    await expect(
      dialog.getByText("Stored as the table household_expenses"),
    ).toBeVisible();
    await expect(dialog.getByText("Done", { exact: true })).toBeVisible();
    await dialog.getByRole("checkbox", { name: /^household_expenses\b/ }).check();
    await expectNoA11yViolations(page);
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toBeVisible();
  });

  let uploaded = "";
  await test.step("its path is an ordinary relative path under its own uploads", async () => {
    const listing = await request.get("/api/sources?workspaceId=demo");
    const row = (await listing.json()).sources.find(
      (s: { id: string }) => s.id === sourceId,
    );
    expect(row?.config?.path).toMatch(/^uploads\/demo\/[0-9a-f]{16}$/);
    uploaded = row.config.path;
    expect(existsSync(join(DUCKDB_DIR, uploaded, "household_expenses.csv"))).toBe(true);
  });

  await test.step("refresh, then generate a dashboard against it", async () => {
    await page.getByRole("button", { name: `Refresh ${sourceName}` }).click();
    const refresh = page.getByRole("dialog");
    await refresh
      .getByRole("button", { name: /^(Mark as refreshed|Apply changes)$/ })
      .click();
    await expect(refresh).toBeHidden();

    await page.goto("/dashboards/new");
    await page.getByRole("button", { name: /^Data source:/ }).click();
    const sources = page.getByRole("menu");
    const pick = sources.getByRole("menuitemcheckbox", { name: new RegExp(sourceName) });
    if ((await pick.getAttribute("aria-checked")) !== "true") await pick.click();
    const others = sources
      .getByRole("menuitemcheckbox", { checked: true })
      .filter({ hasNotText: sourceName });
    while ((await others.count()) > 0) await others.first().click();
    await page.keyboard.press("Escape");
    await page.getByLabel("Describe the dashboard").fill("Where the money goes");
    await page.getByRole("button", { name: "Generate" }).click();
    // The recorded answer for an uploaded expenses file (src/lib/ai/stub.ts).
    const preview = page.getByRole("region", { name: "Dashboard preview" });
    await expect(preview.getByText("Household spending").first()).toBeVisible();
    await preview.getByRole("button", { name: "Save dashboard" }).click();
    const save = page.getByRole("dialog", { name: "Save dashboard" });
    await save.getByRole("button", { name: "Save dashboard" }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
  });

  const dashboardUrl = page.url();
  await test.step("a panel renders from the uploaded rows", async () => {
    await waitForPanels(page);
    const table = page.locator('[data-panel-id="by-month"]');
    await expect(table).toHaveAttribute("data-status", "live", { timeout: 30_000 });
    await expect(page.locator('[data-panel-id="by-category"]')).toHaveAttribute(
      "data-status",
      "live",
    );
  });

  await test.step("add a file to it by dropping it, then review and apply its table (#604)", async () => {
    await page.goto("/data-sources");
    await page.getByRole("button", { name: `Add files to ${sourceName}` }).click();
    const dialog = page.getByRole("dialog", { name: `Add files to ${sourceName}` });
    // Dropped on the picker, as a person drags a file from their desktop.
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(
        new File(["category,budget\nrent,1200\ngroceries,450\n"], "budget.csv", {
          type: "text/csv",
        }),
      );
      return transfer;
    });
    const zone = dialog.locator("fieldset");
    await zone.dispatchEvent("dragenter", { dataTransfer });
    await expect(dialog.getByText("Drop to choose these files")).toBeVisible();
    await zone.dispatchEvent("drop", { dataTransfer });
    await expect(dialog.getByRole("progressbar", { name: "budget.csv" })).toBeVisible();
    await dialog.getByRole("button", { name: "Upload", exact: true }).click();
    // Stored, not yet a table: the refresh opens with it as a new table.
    const refresh = page.getByRole("dialog", { name: `Refresh catalog: ${sourceName}` });
    await expect(refresh.getByText("1 table added.").first()).toBeVisible();
    await expect(refresh.getByText("new table", { exact: true })).toBeVisible();
    await refresh.getByRole("button", { name: "Apply changes" }).click();
    await expect(refresh).toBeHidden();
    expect(existsSync(join(DUCKDB_DIR, uploaded, "budget.csv"))).toBe(true);
    expect(existsSync(join(DUCKDB_DIR, uploaded, "household_expenses.csv"))).toBe(true);

    const answer = await request.post("/api/query", {
      data: {
        sourceId,
        sql: "SELECT category, budget FROM budget ORDER BY budget DESC",
        timeRange: { from: "now-1h", to: "now" },
      },
    });
    expect(answer.ok(), await answer.text()).toBe(true);
    expect((await answer.json()).rows).toEqual([
      { category: "rent", budget: 1200 },
      { category: "groceries", budget: 450 },
    ]);
  });

  const id = dashboardUrl.split("/").at(-1);
  if (id) await request.delete(`/api/dashboards/${id}`);
  const removed = await request.delete(`/api/sources/${sourceId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
  // Deleting an upload source takes its files with it.
  expect(existsSync(join(DUCKDB_DIR, uploaded))).toBe(false);
});

/*
 * Uploading JSON lines (#596): the form's workouts sample, fetched from the
 * app as the button does, stored with its own extension so the directory
 * reads it as JSON, and its nested `location` queried as a STRUCT through
 * the guard.
 */
test("an uploaded JSON-lines sample: stored as JSON, its nested field queried", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const sourceId = `e2e-json-${Date.now().toString(36)}`;
  const sourceName = `E2E JSON ${sourceId}`;

  await page.goto("/data-sources");
  await page.getByRole("button", { name: "Add source" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add source" });
  await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
  await dialog.getByRole("radio", { name: "Upload files" }).click();
  await dialog.getByLabel("Source id").fill(sourceId);
  await dialog.getByLabel("Name").fill(sourceName);
  await dialog.getByRole("button", { name: "workouts" }).click();
  await expect(dialog.getByRole("progressbar", { name: "workouts.jsonl" })).toBeVisible();
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(dialog.getByText("Stored as the table workouts")).toBeVisible();
  await expect(dialog.getByText("Done", { exact: true })).toBeVisible();
  // The nested object is one STRUCT column, offered like any other.
  const table = dialog.getByRole("checkbox", { name: /^workouts\b/ });
  await table.check();
  await dialog.getByRole("button", { name: "Create source" }).click();
  await expect(dialog).toBeHidden();

  const listing = await request.get("/api/sources?workspaceId=demo");
  const row = (await listing.json()).sources.find(
    (s: { id: string }) => s.id === sourceId,
  );
  const uploaded: string = row?.config?.path ?? "";
  expect(existsSync(join(DUCKDB_DIR, uploaded, "workouts.jsonl"))).toBe(true);
  const location = row?.config?.tables?.[0]?.columns?.find(
    (c: { name: string }) => c.name === "location",
  );
  expect(location?.type).toBe("STRUCT(city VARCHAR, country VARCHAR)");

  const answer = await request.post("/api/query", {
    data: {
      sourceId,
      sql: "SELECT location.country AS country, count(*) AS workouts FROM workouts GROUP BY 1 ORDER BY 1",
      timeRange: { from: "now-1h", to: "now" },
    },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
  expect((await answer.json()).rows).toEqual([
    { country: "CA", workouts: 22 },
    { country: "US", workouts: 68 },
  ]);

  const removed = await request.delete(`/api/sources/${sourceId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
  expect(existsSync(join(DUCKDB_DIR, uploaded))).toBe(false);
});

/*
 * Uploading an Excel workbook (#597): the form's home-energy sample, two
 * sheets converted on the server to one CSV each and the workbook not kept,
 * both tables discovered, their date cells typed as dates and their numbers
 * as numbers, and a sheet queried through the guard.
 */
test("an uploaded Excel workbook: one table per sheet, dates typed as dates", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const sourceId = `e2e-xlsx-${Date.now().toString(36)}`;
  const sourceName = `E2E workbook ${sourceId}`;

  await page.goto("/data-sources");
  await page.getByRole("button", { name: "Add source" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add source" });
  await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
  await dialog.getByRole("radio", { name: "Upload files" }).click();
  await dialog.getByLabel("Source id").fill(sourceId);
  await dialog.getByLabel("Name").fill(sourceName);
  await dialog.getByRole("button", { name: "home energy" }).click();
  await expect(
    dialog.getByRole("progressbar", { name: "home-energy.xlsx" }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(
    dialog.getByText(
      "Converted to the tables home_energy_electricity and home_energy_gas",
    ),
  ).toBeVisible();
  await expect(dialog.getByText("Done", { exact: true })).toBeVisible();
  await dialog.getByRole("checkbox", { name: /^home_energy_electricity\b/ }).check();
  await dialog.getByRole("checkbox", { name: /^home_energy_gas\b/ }).check();
  await dialog.getByRole("button", { name: "Create source" }).click();
  await expect(dialog).toBeHidden();

  const listing = await request.get("/api/sources?workspaceId=demo");
  const row = (await listing.json()).sources.find(
    (s: { id: string }) => s.id === sourceId,
  );
  const uploaded: string = row?.config?.path ?? "";
  for (const file of ["home_energy_electricity.csv", "home_energy_gas.csv"]) {
    expect(existsSync(join(DUCKDB_DIR, uploaded, file))).toBe(true);
  }
  expect(existsSync(join(DUCKDB_DIR, uploaded, "home-energy.xlsx"))).toBe(false);
  const gas = row?.config?.tables?.find(
    (t: { name: string }) => t.name === "home_energy_gas",
  );
  const types = Object.fromEntries(
    (gas?.columns ?? []).map((c: { name: string; type: string }) => [c.name, c.type]),
  );
  expect(types).toMatchObject({ date: "DATE", therms: "DOUBLE", cost_usd: "DOUBLE" });

  const answer = await request.post("/api/query", {
    data: {
      sourceId,
      sql: "SELECT count(*) AS days, min(date) AS first FROM home_energy_electricity",
      timeRange: { from: "now-1h", to: "now" },
    },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
  const [first] = (await answer.json()).rows;
  expect(Number(first.days)).toBe(183);
  expect(String(first.first)).toMatch(/^2026-04-01/);

  const removed = await request.delete(`/api/sources/${sourceId}`);
  expect(removed.ok(), await removed.text()).toBe(true);
  expect(existsSync(join(DUCKDB_DIR, uploaded))).toBe(false);
});

test("the seeded Demo files dashboard renders from its Parquet, CSV and JSON files", async ({
  page,
  request,
}) => {
  await page.goto(`/dashboards/${await dashboardId(request, "Demo files")}`);
  await waitForPanels(page);
  // A panel per file: requests by minute (time_bucket), revenue by day
  // (date_trunc), the requests file joined to the CSV inventory, and the
  // deploys from JSON lines with a nested object (#596).
  for (const id of ["rpm", "traffic", "revenue-daily", "requests-by-region", "deploys"]) {
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
