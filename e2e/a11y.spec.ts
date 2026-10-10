import { expect, test } from "@playwright/test";
import { expectNoA11yViolations, type Theme, setAppearance } from "./support/a11y";
import {
  askChat,
  clickChart,
  createDrilldownDashboards,
  createLinkedDashboards,
  createPromqlDashboard,
  DEMO_DASHBOARD,
  dashboardId,
  waitForPanels,
} from "./support/app";

/*
 * Every main surface, in both themes (#91): contrast differs between them, so
 * a token that passes in one can fail in the other.
 */

const THEMES: Theme[] = ["dark", "light"];

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => {
      await setAppearance(page, theme);
    });

    test("dashboard list", async ({ page }) => {
      await page.goto("/dashboards");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("new dashboard", async ({ page }) => {
      await page.goto("/dashboards/new");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("live dashboard", async ({ page, request }) => {
      await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
      await waitForPanels(page);
      await expectNoA11yViolations(page);
    });

    test("the fleet demo: every kind of chart, a custom visual among them", async ({
      page,
      request,
    }) => {
      await page.goto(`/dashboards/${await dashboardId(request, "Demo fleet")}`);
      await waitForPanels(page);
      // The custom visual is named by its panel, not by Vega's own label (#405).
      await expect(
        page.getByRole("img", {
          name: /^Every 5-minute CPU reading, per host, vega chart/,
        }),
      ).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("dashboard editor", async ({ page, request }) => {
      await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}/edit`);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("dashboard editor, a PromQL panel in the inspector (#388)", async ({
      page,
      request,
    }) => {
      await page.goto(`/dashboards/${await createPromqlDashboard(request)}/edit`);
      await page
        .getByRole("button", { name: /^Request rate/ })
        .first()
        .click();
      // The CodeMirror editor replaces the textarea once its chunk loads.
      await expect(page.getByRole("textbox", { name: "Panel PromQL" })).toBeVisible();
      await expect(page.getByLabel("Min step")).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("explore", async ({ page }) => {
      await page.goto("/explore");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("explore with an answer: the view toggles, table tools and session", async ({
      page,
    }) => {
      await page.goto("/explore");
      await page.getByRole("button", { name: /^Data source:/ }).click();
      await page.getByRole("menuitemradio", { name: /Demo TimescaleDB metrics/ }).click();
      await page.keyboard.press("Escape");
      await page.locator("#prompt").fill("Which service is busiest?");
      await page.getByRole("button", { name: "Explore" }).click();
      const table = page.getByRole("region", { name: "Requests by service, table" });
      await expect(table.getByRole("cell", { name: "api", exact: true })).toBeVisible();
      // Every control the answer brings: pin it, open the column filters.
      await page.getByRole("button", { name: "Pin", exact: true }).click();
      await page.getByRole("button", { name: "Column filters" }).click();
      await expect(page.getByRole("textbox", { name: /^Filter / }).first()).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("chat, empty", async ({ page }) => {
      await page.goto("/chat");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("chat with an answer and an inline panel", async ({ page }) => {
      await askChat(page);
      const table = page.getByRole("region", { name: "Requests by service, table" });
      await expect(table.getByRole("cell", { name: "api", exact: true })).toBeVisible();
      await page.getByText("Show query").click();
      await expectNoA11yViolations(page);
    });

    test("data sources", async ({ page }) => {
      await page.goto("/data-sources");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("settings", async ({ page }) => {
      await page.goto("/settings/appearance");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("an open dialog: the panel's SQL", async ({ page, request }) => {
      await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
      await waitForPanels(page);
      await page.getByRole("button", { name: "Actions for 5xx error rate" }).click();
      await page.getByRole("menuitem", { name: "Show query" }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("an open menu: a panel's links", async ({ page, request }) => {
      const { source } = await createLinkedDashboards(request);
      await page.goto(`/dashboards/${source}`);
      await waitForPanels(page);
      await page.getByRole("button", { name: "Actions for Requests by route" }).click();
      await expect(page.getByRole("menuitem", { name: "Checkout detail" })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("an open popover: the links a click offers", async ({ page, request }) => {
      const { fleet } = await createDrilldownDashboards(request, { withSelf: true });
      await page.goto(`/dashboards/${fleet}`);
      await waitForPanels(page);
      await clickChart(page, "hosts");
      await expect(page.getByRole("dialog", { name: "Links from Hosts" })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("the editor's link form", async ({ page, request }) => {
      const { source } = await createLinkedDashboards(request);
      await page.goto(`/dashboards/${source}/edit`);
      await page
        .getByRole("button", { name: /^Requests by route/ })
        .first()
        .click();
      await page.getByRole("button", { name: "Add link" }).click();
      const form = page.getByRole("group", { name: "New link" });
      await form.getByRole("radio", { name: "Another dashboard" }).click();
      await expect(form.getByRole("list", { name: "Dashboards" })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("an open menu: the account menu", async ({ page }) => {
      await page.goto("/dashboards");
      await page.getByRole("button", { name: /account menu/i }).click();
      await expect(page.getByRole("menu")).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("the dashboard chat panel", async ({ page, request }) => {
      await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
      await waitForPanels(page);
      await page
        .getByRole("button", { name: "Ask about this dashboard" })
        .first()
        .click();
      await expect(page.getByRole("textbox").first()).toBeVisible();
      await expectNoA11yViolations(page);

      // An answer, with its Copy and Try again buttons, in the expanded chat.
      const chat = page.getByRole("dialog", { name: "Dashboard chat" });
      await chat.getByRole("textbox", { name: "Message" }).fill("Hello");
      await chat.getByRole("button", { name: "Send" }).click();
      await expect(chat.getByRole("button", { name: "Copy answer" })).toBeVisible();
      await chat.getByRole("button", { name: "Expand chat" }).click();
      // Past the size FLIP, so axe measures the settled box.
      await page.waitForTimeout(600);
      await expectNoA11yViolations(page);
      await chat.getByRole("button", { name: "Shrink chat" }).click();
      await chat.getByRole("button", { name: "Clear chat" }).click();
    });
  });
}

test("signed out: the sign-in card", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  for (const theme of THEMES) {
    await setAppearance(page, theme);
    await page.goto("/dashboards");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoA11yViolations(page);
  }
  await context.close();
});
