import { expect, type Page, test } from "@playwright/test";
import { setAppearance } from "./support/a11y";
import { DEMO_DASHBOARD, dashboardId, waitForPanels } from "./support/app";

/*
 * What axe cannot see, because it is behavior (#77, #91): where focus goes when
 * a dialog opens and closes, that a keyboard can always see where it is, the
 * skip link, and the editor's panel keys.
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

for (const path of ["/dashboards", "/data-sources", "/chat"]) {
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

test("in the editor, Delete on a focused panel tile removes it, and undo restores it", async ({
  page,
  request,
}) => {
  await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}/edit`);
  const tile = page.getByRole("button", { name: /^5xx error rate, column/ });
  await tile.focus();
  // Arrow keys move it: the label follows the panel's new position.
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: /^5xx error rate, column \d+, row 5/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^5xx error rate, column/ }).focus();
  await page.keyboard.press("Delete");
  // The demo panel's SQL is not a starter, so the editor asks first.
  const confirm = page.getByRole("dialog");
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.getByRole("button", { name: /^Delete/ }).click();
  }
  await expect(page.getByRole("button", { name: /^5xx error rate, column/ })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: /^5xx error rate, column/ })).toHaveCount(
    1,
  );
});
