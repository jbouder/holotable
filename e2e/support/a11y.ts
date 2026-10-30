import AxeBuilder from "@axe-core/playwright";
import { source as axeSource } from "axe-core";
import { expect, type Page } from "@playwright/test";

/**
 * The accessibility gate (#91): axe-core over a rendered page.
 *
 * Every violation fails the test, whatever its impact (#685). A finding that
 * is accepted is named here, with the reason, and nowhere else. A spec that
 * needs one more passes it in `exclude` with its own comment.
 */

/** WCAG 2.0, 2.1 and 2.2 A and AA (the 2.2 AA target, #680), and best practice. */
const TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22a",
  "wcag22aa",
  "best-practice",
];

/**
 * Regions axe is not asked to look inside.
 *
 * - ECharts draws into a `<canvas>` whose pixels axe cannot read and whose
 *   generated wrapper elements carry no semantics of their own. What a
 *   screen reader gets instead is the chart's `aria-label` description and
 *   the visually hidden data table beside it (#77), and both of those are
 *   outside this selector and still scanned.
 */
const ALWAYS_EXCLUDE = ["[data-echarts-canvas]"];

/**
 * Rules axe runs with settings of ours.
 *
 * - `region` (every piece of content sits in a landmark) counts an open menu
 *   or listbox (an autocomplete's options) as a region, as it already counts
 *   a dialog. Base UI portals those popups to `<body>`, outside every
 *   landmark, and that is where a popup belongs: it is reached from its
 *   trigger, which sits in a landmark and owns it, not by moving through the
 *   page's regions. The selectors before `[role=menu]` are axe's own default.
 */
const AXE_SOURCE = `${axeSource}
axe.configure({ checks: [{ id: "region", options: {
  regionMatcher: "dialog, [role=dialog], [role=alertdialog], svg, [role=menu], [role=listbox]",
} }] });`;

export type Theme = "light" | "dark";

/**
 * Open every page in `theme` (the color scheme) and `palette` (the named
 * theme, #503), with motion reduced. Reduced because the page
 * entrance (src/app/template.tsx) fades in from transparent, and axe measuring
 * contrast halfway through that fade reports text that is fine once it lands.
 */
export async function setAppearance(
  page: Page,
  theme: Theme,
  palette: string = "holotable",
): Promise<void> {
  await page.addInitScript(
    ([t, p]) => {
      try {
        window.localStorage.setItem("theme", t);
        window.localStorage.setItem("palette", p);
        window.localStorage.setItem("motion", "reduce");
      } catch {
        // A page without storage just renders the default theme.
      }
    },
    [theme, palette] as const,
  );
}

export async function expectNoA11yViolations(
  page: Page,
  options: { exclude?: string[]; include?: string } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page, axeSource: AXE_SOURCE }).withTags(TAGS);
  if (options.include) builder = builder.include(options.include);
  for (const selector of [...ALWAYS_EXCLUDE, ...(options.exclude ?? [])]) {
    builder = builder.exclude(selector);
  }
  const { violations } = await builder.analyze();

  const describe = (v: (typeof violations)[number]) =>
    `${v.id} (${v.impact}): ${v.help}\n${v.nodes
      .slice(0, 5)
      .map(
        (n) =>
          `    ${n.target.join(" ")}\n      ${n.html}\n      ${n.failureSummary?.split("\n").join("\n      ")}`,
      )
      .join("\n")}`;

  expect(violations.map(describe), `axe violations on ${page.url()}`).toEqual([]);
}
