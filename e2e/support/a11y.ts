import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

/**
 * The accessibility gate (#91): axe-core over a rendered page.
 *
 * Serious and critical violations fail the test. Moderate and minor ones are
 * reported as annotations on it — visible in the list and HTML reporters —
 * without gating, so they can be worked down rather than ignored.
 *
 * Every exclusion is named here, with the reason, and nowhere else. A spec
 * that needs one more passes it in `exclude` with its own comment.
 */

/** WCAG 2.1 A and AA, which is the bar #77 sets. */
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];

const GATING = new Set(["serious", "critical"]);

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

export type Theme = "light" | "dark";

/**
 * Open every page in `theme`, with motion reduced. Reduced because the page
 * entrance (src/app/template.tsx) fades in from transparent, and axe measuring
 * contrast halfway through that fade reports text that is fine once it lands.
 */
export async function setAppearance(page: Page, theme: Theme): Promise<void> {
  await page.addInitScript((t) => {
    try {
      window.localStorage.setItem("theme", t);
      window.localStorage.setItem("motion", "reduce");
    } catch {
      // A page without storage just renders the default theme.
    }
  }, theme);
}

export async function expectNoA11yViolations(
  page: Page,
  options: { exclude?: string[]; include?: string } = {},
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(TAGS);
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
          `    ${n.target.join(" ")}\n      ${n.failureSummary?.split("\n").join("\n      ")}`,
      )
      .join("\n")}`;

  for (const v of violations.filter((v) => !GATING.has(v.impact ?? ""))) {
    test.info().annotations.push({ type: `a11y ${v.impact}`, description: describe(v) });
  }
  const gating = violations.filter((v) => GATING.has(v.impact ?? ""));
  expect(gating.map(describe), `serious or critical violations on ${page.url()}`).toEqual(
    [],
  );
}
