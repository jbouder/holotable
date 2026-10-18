import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PALETTE_INFO } from "../src/lib/theme";
import { expectNoA11yViolations, type Theme, setAppearance } from "./support/a11y";
import {
  askChat,
  clickChart,
  createDrilldownDashboards,
  createLinkedDashboards,
  createLogqlDashboard,
  createPromqlDashboard,
  copyDashboard,
  createShareLink,
  DEMO_DASHBOARD,
  dashboardId,
  discoverLokiLabels,
  openLokiForm,
  unique,
  waitForPanels,
} from "./support/app";

/*
 * The accessibility scans (#91), and what is scanned where (#610).
 *
 * Every main surface, its dialogs, menus and popovers, in the default
 * palette's two schemes, dark and light: what only a browser can prove is
 * that a surface is built right (roles, names, labels, focus, nothing
 * unnamed), and contrast differs between the schemes, so a token that passes
 * in one can fail in the other.
 *
 * Each other shipped palette (#503) is scanned on one page, the live
 * dashboard (the most components at once, a truncation popover among them),
 * in both of its schemes, so the palette switch and its tokens are still
 * exercised in a browser. That every token pairing meets AA in every palette
 * is held without a browser, by test/contrast.test.ts (CONTRAST_PAIRS, every
 * palette's blocks over Holotable's) and test/theme-quality.test.ts (every
 * shipped theme against the quality bar in both schemes); scanning thirty
 * surfaces sixteen times proved that again, slowly.
 *
 * The forced-colors tests, the embed's theme from its link (hostile values
 * included) and the signed-out card are below, unchanged.
 *
 * A scan that stores an upload is tagged @serial and runs in the serial
 * project (e2e/playwright.config.ts): uploads are rate limited per person,
 * and the DuckDB spec spends from the same budget.
 */

const THEMES: Theme[] = ["dark", "light"];

/** A scan that stores an upload: run one at a time, after the parallel specs. */
const SERIAL = { tag: "@serial" };

// Every surface in the default palette, in each scheme.
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

    test("models, and the Add model dialog", async ({ page }) => {
      await page.goto("/models");
      await expect(page.getByRole("heading", { level: 1, name: "Models" })).toBeVisible();
      await expectNoA11yViolations(page);
      await page.getByRole("button", { name: "Add model to demo" }).click();
      await expect(page.getByRole("dialog", { name: "Add model" })).toBeVisible();
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
      // The per-minute series overflow the e2e window (MAX_WINDOW_POINTS), so
      // the truncation badge (#486) is scanned too, and its popover.
      const cut = page.getByRole("button", { name: /some rows are not shown/ }).first();
      await expect(cut).toBeVisible();
      await expectNoA11yViolations(page);
      await cut.click();
      await expect(page.getByText(/MAX_WINDOW_POINTS rows/)).toBeVisible();
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

    test("dashboard editor, a LogQL panel in the inspector (#565)", async ({
      page,
      request,
    }) => {
      await page.goto(`/dashboards/${await createLogqlDashboard(request)}/edit`);
      await page
        .getByRole("button", { name: /^API lines/ })
        .first()
        .click();
      // The CodeMirror editor replaces the textarea once its chunk loads.
      const editor = page.getByRole("textbox", { name: "Panel LogQL" });
      await expect(editor).toBeVisible();
      await expectNoA11yViolations(page);
      // A listed label's values are offered inside a matcher's quotes.
      await editor.click();
      await page.keyboard.press("ControlOrMeta+End");
      await page.keyboard.type(' | level="');
      await expect(page.getByRole("option", { name: /^error/ })).toBeVisible();
      await expectNoA11yViolations(page);
      await page.keyboard.press("Escape");
    });

    test("explore, empty", async ({ page }) => {
      await page.goto("/explore");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("explore with an answer and an inline panel", async ({ page }) => {
      await askChat(page);
      const table = page.getByRole("region", { name: "Requests by service, table" });
      await expect(table.getByRole("cell", { name: "api", exact: true })).toBeVisible();
      await page.getByText("Show query").click();
      await expectNoA11yViolations(page);
    });

    test("explore with the history filter in use", async ({ page }) => {
      await askChat(page);
      await expect(
        page.getByRole("region", { name: "Requests by service, table" }),
      ).toBeVisible();
      await page.getByRole("textbox", { name: "Filter conversations" }).fill("busiest");
      await expectNoA11yViolations(page);
    });

    test("explore at phone width with the side panel open", async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto("/explore");
      await page.getByRole("button", { name: /source.* · / }).click();
      await expect(page.getByRole("dialog", { name: "Conversation" })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("data sources", async ({ page }) => {
      await page.goto("/data-sources");
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test("the DuckDB source form, with its path picker open", async ({ page }) => {
      await page.goto("/data-sources");
      await page.getByRole("button", { name: "Add source" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Add source" });
      await dialog
        .getByRole("button", { name: "or enter configuration manually" })
        .click();
      await dialog.getByRole("radio", { name: "DuckDB (files)" }).click();
      await dialog.getByRole("combobox", { name: "Path" }).click();
      await expect(page.getByRole("option", { name: /requests/ })).toBeVisible();
      await expectNoA11yViolations(page);
    });

    test(
      "the upload form, finished, with its progress bars (#595)",
      SERIAL,
      async ({ page }) => {
        await page.goto("/data-sources");
        await page.getByRole("button", { name: "Add source" }).first().click();
        const dialog = page.getByRole("dialog", { name: "Add source" });
        await dialog
          .getByRole("button", { name: "or enter configuration manually" })
          .click();
        await dialog.getByRole("radio", { name: "Upload files" }).click();
        await dialog.getByRole("button", { name: "household expenses" }).click();
        await expect(dialog.getByRole("progressbar")).toBeVisible();
        await dialog.getByRole("button", { name: "Upload", exact: true }).click();
        await expect(dialog.getByText("Done", { exact: true })).toBeVisible();
        await expectNoA11yViolations(page);
      },
    );

    test(
      "the Add files dialog on an upload source, with a file chosen (#604)",
      SERIAL,
      async ({ page, request }) => {
        const id = `a11y-add-${theme}-${unique()}`;
        const name = `A11y upload ${id}`;
        const upload = await request.post(
          "/api/sources/duckdb/uploads?workspaceId=demo",
          {
            multipart: {
              files: {
                name: "a11y.csv",
                mimeType: "text/csv",
                buffer: Buffer.from("a\n1\n"),
              },
            },
          },
        );
        expect(upload.ok(), await upload.text()).toBe(true);
        const { path } = await upload.json();
        const created = await request.post("/api/sources", {
          data: {
            workspaceId: "demo",
            id,
            name,
            config: {
              kind: "duckdb",
              path,
              tables: [{ name: "a11y", columns: [{ name: "a", type: "BIGINT" }] }],
            },
          },
        });
        expect(created.ok(), await created.text()).toBe(true);
        try {
          await page.goto("/data-sources");
          await page.getByRole("button", { name: `Add files to ${name}` }).click();
          const dialog = page.getByRole("dialog", { name: `Add files to ${name}` });
          await expect(dialog).toBeVisible();
          await expectNoA11yViolations(page);
          await dialog.getByRole("button", { name: "household expenses" }).click();
          await expect(dialog.getByRole("progressbar")).toBeVisible();
          await expectNoA11yViolations(page);
        } finally {
          await request.delete(`/api/sources/${id}`);
        }
      },
    );

    test(
      "new dashboard led by a recognized starter, and the starter applied (#606)",
      SERIAL,
      async ({ page, request }) => {
        const id = `a11y-starter-${theme}-${unique()}`;
        const upload = await request.post(
          "/api/sources/duckdb/uploads?workspaceId=demo",
          {
            multipart: {
              files: {
                name: "household-expenses.csv",
                mimeType: "text/csv",
                buffer: readFileSync(
                  join(process.cwd(), "public/samples/household-expenses.csv"),
                ),
              },
            },
          },
        );
        expect(upload.ok(), await upload.text()).toBe(true);
        const { path } = await upload.json();
        const created = await request.post("/api/sources", {
          data: {
            workspaceId: "demo",
            id,
            name: `A11y starter ${id}`,
            config: {
              kind: "duckdb",
              path,
              tables: [
                {
                  name: "household_expenses",
                  timeField: "date",
                  columns: [
                    { name: "date", type: "DATE" },
                    { name: "merchant", type: "VARCHAR" },
                    { name: "category", type: "VARCHAR" },
                    { name: "amount", type: "DOUBLE" },
                    { name: "payment_method", type: "VARCHAR" },
                  ],
                },
              ],
            },
          },
        });
        expect(created.ok(), await created.text()).toBe(true);
        try {
          await page.goto(`/dashboards/new?source=${id}`);
          const start = page.getByRole("button", {
            name: "Start from Spending — household_expenses",
          });
          await expect(start).toBeVisible();
          await expectNoA11yViolations(page);
          await start.click();
          const preview = page.getByRole("region", { name: "Dashboard preview" });
          await expect(
            preview.getByRole("heading", { name: "Spending — household_expenses" }),
          ).toBeVisible();
          await expect(
            preview.locator('[data-panel-id][data-status="loading"]'),
          ).toHaveCount(0);
          await expectNoA11yViolations(page);
        } finally {
          await request.delete(`/api/sources/${id}`);
        }
      },
    );

    test("data sources, the Loki form and its discovered labels (#563)", async ({
      page,
    }) => {
      const dialog = await openLokiForm(page);
      await expect(dialog.getByRole("radio", { name: "Loki (LogQL)" })).toBeChecked();
      await expectNoA11yViolations(page);
      await discoverLokiLabels(dialog);
      await expect(dialog.getByLabel("Search the discovered labels")).toBeVisible();
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

    test("an open menu taller than the viewport scrolls inside itself", async ({
      page,
    }) => {
      // The account menu in a window too short for it stands in for a
      // workspace with many sources (#585).
      await page.setViewportSize({ width: 1280, height: 240 });
      await page.goto("/dashboards");
      await page.getByRole("button", { name: /account menu/i }).click();
      const menu = page.getByRole("menu");
      await expect(menu).toBeVisible();
      const box = await menu.boundingBox();
      expect(box && box.y + box.height).toBeLessThanOrEqual(240);
      expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      // The first item is reachable, and the keyboard brings the last into view.
      await expect(page.getByRole("menuitem").first()).toBeInViewport();
      await page.keyboard.press("End");
      await expect(page.getByRole("menuitem").last()).toBeFocused();
      await expect(page.getByRole("menuitem").last()).toBeInViewport();
      await expectNoA11yViolations(page);
    });

    test("the dashboard chat panel", async ({ page, request }) => {
      // A copy: a dashboard's chat is stored per person, and other tests chat
      // on the seeded one at the same time.
      await page.goto(`/dashboards/${await copyDashboard(request, DEMO_DASHBOARD)}`);
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

/**
 * Every other shipped palette (#503), on the live dashboard in both schemes:
 * the switch reaches the page, and its tokens draw a scanned surface. The
 * pairings themselves are measured in test/contrast.test.ts and
 * test/theme-quality.test.ts.
 */
for (const palette of PALETTE_INFO.filter((p) => p.name !== "holotable")) {
  for (const theme of THEMES) {
    test(`${palette.label} ${theme}: the live dashboard`, async ({ page, request }) => {
      await setAppearance(page, theme, palette.name);
      await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
      await expect(page.locator("html")).toHaveAttribute("data-palette", palette.name);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await waitForPanels(page);
      const cut = page.getByRole("button", { name: /some rows are not shown/ }).first();
      await expect(cut).toBeVisible();
      await expectNoA11yViolations(page);
      await cut.click();
      await expect(page.getByText(/MAX_WINDOW_POINTS rows/)).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }
}

test("signed out: the sign-in card", async ({ browser }) => {
  // A page without a session goes straight to the realm, unless its visitor
  // just signed out: that is who sees the card (e2e/sign-in.spec.ts).
  const context = await browser.newContext({
    storageState: {
      cookies: [
        {
          name: "holotable_signed_out",
          value: "1",
          domain: "localhost",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
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

test("the named theme is on <html> before first paint", async ({ page }) => {
  // #503: the bootstrap script writes it with the scheme, so nothing flashes.
  await page.goto("/dashboards", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-palette", "holotable");
});

// The operating system's forced colors (#506): Windows High Contrast replaces
// every color. axe-core does not model forced colors: it measures the page's
// own colors against the system's Canvas and fails every text node. So this
// asserts what the forced-colors rules in globals.css promise instead.
test.describe("forced colors", () => {
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ forcedColors: "active", colorScheme: "light" });
    await setAppearance(page, "light");
  });

  test("a chart opts out and draws, a tint keeps an edge", async ({ page, request }) => {
    await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
    await waitForPanels(page);
    const canvas = page.locator("[data-echarts-canvas]").first();
    await expect(canvas).toHaveCSS("forced-color-adjust", "none");
    // A status pill was told apart by its fill, which the system strips.
    const pill = page.locator(".tinted[class*='bg-tint-']").first();
    await expect(pill).toHaveCSS("outline-style", "solid");
  });

  test("focus is drawn in the system's Highlight, as a ring even on a filled button", async ({
    page,
  }) => {
    await page.goto("/dashboards");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const highlight = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "Highlight";
      document.body.append(probe);
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    // The primary action: a `bg-primary` fill, which forced colors outline.
    const button = page.getByRole("link", { name: "Create New Dashboard" });
    await button.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(button).toHaveCSS("outline-color", highlight);
    // A real ring, not a color on no outline: the fill's 1px forced-colors
    // edge must not replace it while focused.
    await expect(button).toHaveCSS("outline-style", "solid");
    await expect(button).toHaveCSS("outline-width", "2px");
  });
});

test("an embed is drawn in the theme its link names, and only a shipped one", async ({
  browser,
  request,
}) => {
  // #509: an embed's storage is empty or the host's, so the link carries the
  // look. A fresh context has no storage at all.
  const url = new URL(
    await createShareLink(request, await dashboardId(request, DEMO_DASHBOARD)),
  );
  const path = `${url.pathname}${url.search}`;
  // Reduced motion through the system setting, so storage stays empty and
  // axe does not catch the panels mid-entrance.
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${path}&theme=paper&scheme=light`, { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute("data-palette", "paper");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await waitForPanels(page);
  await expectNoA11yViolations(page);
  // Anything else is the default, and never written into the page as a
  // value: a distinctive name, so an echo cannot hide behind encoding.
  const hostile = await page.goto(`${path}&theme=zzhostile&scheme=zzscheme`);
  const body = (await hostile?.text()) ?? "";
  for (const value of ["zzhostile", "zzscheme"]) {
    expect(body.match(new RegExp(`data-[a-z-]+="${value}"|"${value}"`))).toBeNull();
  }
  await expect(page.locator("html")).toHaveAttribute("data-palette", "holotable");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await context.close();
});

test("the share dialog's theme choice", async ({ page, request }) => {
  // #509: reachable and scanned, in the dialog that writes it into the link.
  await setAppearance(page, "dark");
  await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
  await waitForPanels(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Share read-only/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share read-only" });
  await expect(dialog.getByRole("combobox", { name: "Theme" })).toBeVisible();
  await expectNoA11yViolations(page);
});
