import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { setAppearance } from "./support/a11y";
import {
  clickChart,
  copyDashboard,
  createDrilldownDashboards,
  DEMO_DASHBOARD,
  dashboardId,
  waitForPanels,
} from "./support/app";

/*
 * What axe cannot see, because it is behavior (#77, #91): where focus goes when
 * a dialog opens and closes, that a keyboard can always see where it is on
 * every main surface (#684), the skip link, and the theme gallery's arrow
 * keys. The editor's panel keys (arrows move a tile, Delete removes it) are
 * held by test/panel-layout-grid.test.tsx, and its undo by
 * test/editor-history.test.ts.
 */

test.beforeEach(async ({ page }) => {
  await setAppearance(page, "dark");
});

/** More presses than any page has Tab stops; reaching it fails the walk, loudly. */
const MAX_STOPS = 300;

type Stop = {
  name: string;
  visible: boolean;
  obscured: boolean;
  inside: boolean;
  seen: boolean;
};

/**
 * The focused element: is it drawn with an indicator (2.4.7), is it entirely
 * covered by something else, a sticky header say (2.4.11), is it still inside
 * `within`, and has the walk been here before. Each stop is marked as it is
 * reached, so a walk ends when focus comes back round, including inside a
 * popup that traps it.
 */
function focusStop(page: Page, within: string | undefined): Promise<Stop> {
  return page.evaluate((within) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) {
      return {
        name: "body",
        visible: false,
        obscured: false,
        inside: false,
        seen: false,
      };
    }
    const name = `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} ${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 40)}`;
    const seen = el.hasAttribute("data-focus-walk");
    el.setAttribute("data-focus-walk", "");

    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0;
    const ring = s.boxShadow !== "none";
    // A menu item or an option is shown by its highlight, the menu pattern,
    // not a ring: Base UI marks the one the arrow keys are on.
    const highlighted = el.hasAttribute("data-highlighted");

    // Covered only if every probe point, the center and four inset corners,
    // lands on something that is neither the element nor part of it.
    const r = el.getBoundingClientRect();
    const dx = Math.min(4, r.width / 2);
    const dy = Math.min(4, r.height / 2);
    const points: [number, number][] = [
      [r.left + r.width / 2, r.top + r.height / 2],
      [r.left + dx, r.top + dy],
      [r.right - dx, r.top + dy],
      [r.left + dx, r.bottom - dy],
      [r.right - dx, r.bottom - dy],
    ];
    const obscured = points.every(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && hit !== el && !el.contains(hit) && !hit.contains(el);
    });

    return {
      name,
      visible: outline || ring || highlighted,
      obscured,
      inside: !within || el.closest(within) !== null,
      seen,
    };
  }, within);
}

/**
 * Press `key` until focus comes back to a stop already seen, or leaves
 * `within`, and say which stops had no visible indicator or were hidden
 * behind something. Leaving the end of the page wraps to its top, so a page
 * that puts focus partway down (Explore's prompt) is still walked whole.
 */
async function walkFocus(
  page: Page,
  { key = "Tab", within }: { key?: string; within?: string } = {},
) {
  const invisible: string[] = [];
  const obscured: string[] = [];
  const check = (stop: Stop) => {
    if (!stop.visible) invisible.push(stop.name);
    if (stop.obscured) obscured.push(stop.name);
  };
  let stops = 0;
  const onControl =
    within !== undefined &&
    (await page.evaluate((within) => {
      const el = document.activeElement;
      return el?.closest(within) != null && !el.matches(within);
    }, within));
  if (onControl && key === "Tab") {
    // A popup opened by a click can put focus on its first control without a
    // keyboard, so no indicator is due yet. Out and back makes it a keyboard
    // focus, and checks it.
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
    const first = await focusStop(page, within);
    expect(first.inside, "Shift+Tab left the popup").toBe(true);
    check(first);
    stops++;
  }
  for (let presses = 0; ; presses++) {
    expect(presses, `more than ${MAX_STOPS} presses: is focus stuck?`).toBeLessThan(
      MAX_STOPS,
    );
    await page.keyboard.press(key);
    const stop = await focusStop(page, within);
    if (stop.name === "body" && !within) continue;
    if (stop.seen || !stop.inside) break;
    check(stop);
    stops++;
  }
  expect(stops, "the walk reached no stop at all").toBeGreaterThan(0);
  expect(invisible, "focused without a visible indicator").toEqual([]);
  expect(obscured, "focused but hidden behind something").toEqual([]);
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
  await page.goto("/");
  const trigger = page.getByRole("button", { name: /account menu/i });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(trigger).toBeFocused();
});

test("the first Tab offers a skip link that lands on the page", async ({ page }) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();
});

// Every main surface the axe scans open (e2e/a11y.spec.ts), walked from the
// top to the last Tab stop (#684).
const PAGES: { name: string; path: (request: APIRequestContext) => Promise<string> }[] = [
  { name: "the dashboard list", path: async () => "/" },
  { name: "a new dashboard", path: async () => "/dashboards/new" },
  { name: "data sources", path: async () => "/data-sources" },
  { name: "explore", path: async () => "/explore" },
  { name: "models", path: async () => "/models" },
  { name: "settings", path: async () => "/settings/appearance" },
  {
    name: "a live dashboard",
    path: async (request) => `/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`,
  },
  {
    name: "the dashboard editor",
    path: async (request) =>
      `/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}/edit`,
  },
];

for (const { name, path } of PAGES) {
  test(`every Tab stop on ${name} shows where focus is`, async ({ page, request }) => {
    const url = await path(request);
    await page.goto(url);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // A live dashboard's panels add stops (their menus, tables) as they land.
    if (/^\/dashboards\/[^/]+$/.test(url) && !url.endsWith("/new"))
      await waitForPanels(page);
    await walkFocus(page);
  });
}

test("every Tab stop in an open dialog shows where focus is", async ({
  page,
  request,
}) => {
  await page.goto(`/dashboards/${await dashboardId(request, DEMO_DASHBOARD)}`);
  await waitForPanels(page);
  await page.getByRole("button", { name: "Actions for 5xx error rate" }).click();
  await page.getByRole("menuitem", { name: "Show query" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await walkFocus(page, { within: "[role=dialog]" });
});

test("every item in an open menu shows where focus is", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /account menu/i }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  // A menu is walked by its arrow keys; Tab closes it.
  await walkFocus(page, { key: "ArrowDown", within: "[role=menu]" });
});

test("every Tab stop in an open popover shows where focus is", async ({
  page,
  request,
}) => {
  const { fleet } = await createDrilldownDashboards(request, { withSelf: true });
  await page.goto(`/dashboards/${fleet}`);
  await waitForPanels(page);
  await clickChart(page, "hosts");
  await expect(page.getByRole("dialog", { name: "Links from Hosts" })).toBeVisible();
  await walkFocus(page, { within: "[role=dialog]" });
});

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
