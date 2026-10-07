import { expect, test } from "@playwright/test";
import { PG_PORT } from "./env";
import { observeSse, sseCounts } from "./support/sse";

/*
 * The core journey (#88), as one story told in order: register a source, test
 * it, refresh its catalog, generate a dashboard from a prompt, save it, watch
 * live data arrive over SSE, pause and resume, edit a panel, and save a new
 * version. The model is the recorded stub (AI_PROVIDER=stub), so the spec it
 * returns is fixed and nothing here depends on a live model.
 */

test("source → generate → save → stream → pause → resume → edit → new version", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  const sourceId = `e2e-${Date.now().toString(36)}`;
  const sourceName = `E2E metrics ${sourceId}`;

  await test.step("register a source", async () => {
    await page.goto("/data-sources");
    await page.getByRole("button", { name: "Add source" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add source" });
    // The plain-English drafter is the default; this source is typed in.
    await dialog.getByRole("button", { name: "or enter configuration manually" }).click();
    await dialog.getByLabel("Source id").fill(sourceId);
    await dialog.getByLabel("Name").fill(sourceName);
    await dialog.getByRole("combobox", { name: "secret_ref" }).click();
    await page.getByRole("option", { name: "TS_METRICS" }).click();
    await dialog.getByLabel("Host").fill("localhost");
    await dialog.getByLabel("Port").fill(String(PG_PORT));
    await dialog.getByLabel("Database").fill("holotable");
    await dialog.getByLabel("Schema").fill("metrics");
    await dialog.getByRole("button", { name: "Discover tables" }).click();
    await dialog.getByRole("checkbox", { name: /^http_requests\s*\d+ columns$/ }).check();
    await dialog.getByRole("button", { name: "Create source" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toBeVisible();
  });

  await test.step("test the connection", async () => {
    await page.getByRole("button", { name: `Test ${sourceName}` }).click();
    // The one allowlisted table, read through the source's own credentials.
    await expect(page.getByText("1 table readable")).toBeVisible();
  });

  await test.step("refresh the catalog", async () => {
    await page.getByRole("button", { name: `Refresh ${sourceName}` }).click();
    // Reviewed before it is written (#123): the live table matches what was
    // just discovered, so there is nothing to change but the timestamp.
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("button", { name: /^(Mark as refreshed|Apply changes)$/ })
      .click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(`#source-${sourceId}`)).toContainText("Catalog fresh");
  });

  let dashboardUrl = "";
  await test.step("generate a dashboard from a prompt and save it", async () => {
    await page.goto("/dashboards/new");
    // The source is a chip (#356); its menu holds the picker.
    await page.getByRole("button", { name: /^Data source:/ }).click();
    await page.getByRole("menuitemradio", { name: new RegExp(sourceName) }).click();
    await page.keyboard.press("Escape");
    await page.getByLabel("Describe the dashboard").fill("Checkout service health");
    await page.getByRole("button", { name: "Generate" }).click();
    // The recorded spec (src/lib/ai/stub.ts), previewed where the author is
    // already looking: no tab to switch to.
    const preview = page.getByRole("region", { name: "Dashboard preview" });
    await expect(preview.getByText("Checkout service health").first()).toBeVisible();
    await preview.getByRole("button", { name: "Save dashboard" }).click();
    // Save confirms the title before anything is written.
    const save = page.getByRole("dialog", { name: "Save dashboard" });
    await expect(save.getByLabel("Title")).toHaveValue("Checkout service health");
    await save.getByRole("button", { name: "Save dashboard" }).click();
    await page.waitForURL(/\/dashboards\/[0-9a-f-]{36}$/);
    dashboardUrl = page.url();
  });

  await test.step("live data arrives over SSE", async () => {
    await observeSse(page);
    await page.goto(dashboardUrl);
    await expect
      .poll(async () => (await sseCounts(page)).rows, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await expect(
      page.locator('[data-panel-id="requests"][data-status="live"]'),
    ).toBeVisible();
    // And it keeps arriving: the stub dashboard refreshes every 2s.
    const first = (await sseCounts(page)).ticks;
    await expect
      .poll(async () => (await sseCounts(page)).ticks, { timeout: 30_000 })
      .toBeGreaterThan(first);
  });

  await test.step("pause stops the stream; resume starts it again", async () => {
    await page.getByRole("button", { name: "Pause live updates" }).click();
    await expect(
      page.getByRole("button", { name: "Resume live updates" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => (await sseCounts(page)).closed).toBeGreaterThan(0);
    const paused = await sseCounts(page);
    await page.waitForTimeout(5_000);
    expect((await sseCounts(page)).ticks, "no ticks arrive while paused").toBe(
      paused.ticks,
    );

    await page.getByRole("button", { name: "Resume live updates" }).click();
    await expect
      .poll(async () => (await sseCounts(page)).ticks, { timeout: 30_000 })
      .toBeGreaterThan(paused.ticks);
    expect((await sseCounts(page)).opened).toBeGreaterThan(paused.opened);
  });

  await test.step("edit a panel and save a new version", async () => {
    const id = new URL(dashboardUrl).pathname.split("/").pop();
    const before = await request.get(`/api/dashboards/${id}`);
    const { dashboard } = (await before.json()) as { dashboard: { version: number } };

    await page.goto(`${dashboardUrl}/edit`);
    await page
      .getByRole("button", { name: /^Requests per minute/ })
      .first()
      .click();
    // The selected panel's own title field (the dashboard has one too).
    await page.locator("#p-title").fill("Requests per minute, edited");
    await page.getByRole("button", { name: "Save version" }).click();

    await expect
      .poll(async () => {
        const res = await request.get(`/api/dashboards/${id}`);
        return ((await res.json()) as { dashboard: { version: number } }).dashboard
          .version;
      })
      .toBe(dashboard.version + 1);
  });
});
