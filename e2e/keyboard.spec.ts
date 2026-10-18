import { expect, type Page, test } from "@playwright/test";
import { setAppearance } from "./support/a11y";
import { copyDashboard, DEMO_DASHBOARD, dashboardId, waitForPanels } from "./support/app";

/*
 * What axe cannot see, because it is behavior (#77, #91): where focus goes when
 * a dialog opens and closes, that a keyboard can always see where it is, the
 * skip link, and the theme gallery's arrow keys. The editor's panel keys
 * (arrows move a tile, Delete removes it) are held by
 * test/panel-layout-grid.test.tsx, and its undo by test/editor-history.test.ts.
 */

test.beforeEach(async ({ page }) => {
  await setAppearance(page, "dark");
});

/** Is the focused element drawn with a visible indicator? */
function focusIndicator(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { tag: "body", visible: false };
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0;
    const ring = s.boxShadow !== "none";
    return {
      tag: `${el.tagName.toLowerCase()} ${el.getAttribute("aria-label") ?? el.textContent?.trim().slice(0, 30)}`,
      visible: outline || ring,
    };
  });
}

test("a dialog traps focus and gives it back to what opened it", async ({
  page,
  request,
}) => {
  await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
  await waitForPanels(page);
  // The SQL dialog opens from the panel's actions menu, and closing it hands
  // focus back to that menu's trigger.
  const opener = page.getByRole("button", { name: "Actions for 5xx error rate" });
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Show query" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // Twenty Tabs cannot leave it.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    // Base UI wraps the popup in focus guards: a Tab off either end lands on
    // one for a frame, which sends focus back round to the other end.
    await expect
      .poll(() => dialog.evaluate((d) => d.contains(document.activeElement)), {
        message: `Tab ${i + 1} left the dialog`,
        timeout: 2_000,
      })
      .toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);

  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
});

test("the share dialog keeps focus while it creates a link", async ({
  page,
  request,
}) => {
  // #540: Create link disabled itself while focused, which dropped focus to
  // the page behind the modal, and the next Tabs walked the page. On a copy,
  // since this revokes every link it lists and the embed scan in
  // a11y.spec.ts holds one on the seeded dashboard at the same time.
  await page.goto(`/dashboards/${await copyDashboard(request, DEMO_DASHBOARD)}`);
  await waitForPanels(page);
  await page.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: /Share read-only/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share read-only" });
  const create = dialog.getByRole("button", { name: "Create link" });
  await create.focus();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("textbox", { name: "Share link" })).toBeVisible();
  await expect(create).toBeFocused();

  // Past the last Revoke and round again.
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((d) => d.contains(document.activeElement)), {
        message: `Tab ${i + 1} left the dialog`,
        timeout: 2_000,
      })
      .toBe(true);
  }
  // Revoke every active link, so a rerun starts from the same list. One at a
  // time: each revoke reloads the list, so a locator taken before it is stale.
  const revokes = dialog.getByRole("button", { name: "Revoke" });
  for (let left = await revokes.count(); left > 0; left--) {
    await revokes.first().click();
    await expect(revokes).toHaveCount(left - 1);
  }
});

test("the account menu returns focus to its trigger on Escape", async ({ page }) => {
  await page.goto("/dashboards");
  const trigger = page.getByRole("button", { name: /account menu/i });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the first Tab offers a skip link that lands on the page", async ({ page }) => {
  await page.goto("/dashboards");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

for (const path of ["/dashboards", "/data-sources", "/explore"]) {
  test(`every Tab stop on ${path} shows where focus is`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const invisible: string[] = [];
    for (let i = 0; i < 25; i++) {
      await page.keyboard.press("Tab");
      const { tag, visible } = await focusIndicator(page);
      if (tag === "body") break;
      if (!visible) invisible.push(tag);
    }
    expect(invisible, "focused without a visible indicator").toEqual([]);
  });
}

test("the theme gallery is a radio group: Tab reaches the choice, arrows move and choose", async ({
  page,
}) => {
  // #507: a ChoiceCard group. Tab from the group before it reaches the chosen
  // card, an arrow key moves to the next one and chooses it, and the page
  // follows at once.
  await page.goto("/settings/appearance");
  const themes = page.getByRole("radiogroup", { name: "Theme" });
  const holotable = themes.getByRole("radio", { name: "Holotable" });
  const graphite = themes.getByRole("radio", { name: "Graphite" });
  const scheme = page
    .getByRole("radiogroup", { name: "Color scheme" })
    .getByRole("radio", { checked: true });
  // The server's markup already says which card is chosen; retry until the
  // keys reach a hydrated group, so an early press is not the test's result.
  await expect(async () => {
    await scheme.focus();
    await page.keyboard.press("Tab");
    await expect(holotable).toBeFocused({ timeout: 500 });
    await page.keyboard.press("ArrowRight");
    await expect(graphite).toHaveAttribute("aria-checked", "true", { timeout: 500 });
  }).toPass();
  await expect(graphite).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-palette", "graphite");
  // The ring itself, not the chosen card's inset ring (a shadow).
  await expect(graphite).toHaveCSS("outline-style", "solid");
  // Every card is named by its label and described by its sentence.
  await expect(graphite).toHaveAccessibleDescription(/violet accent/);
});
