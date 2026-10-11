import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { hexToRgb, parseThemeBlocks } from "@/lib/color/contrast";
import { DEFICIENCIES, deltaE, MACHADO, simulate } from "@/lib/color/cvd";
import { type QualityTier, qualityReport } from "@/lib/color/quality";
import { PALETTE_INFO } from "@/lib/theme";

/*
 * The theme quality bar (#504). Every theme in globals.css, in each scheme,
 * clears every rule at the built-in tier, so a token tweak that lets a border
 * vanish, a status color merge under a color-vision deficiency or the focus
 * ring disappear fails here, naming the rule, where and the number.
 */

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");
const BLOCKS = parseThemeBlocks(CSS);

/** The tier a shipped theme is held to: high contrast its own, every other built in. */
const tierOf = (palette: string) =>
  PALETTE_INFO.find((p) => p.name === palette)?.highContrast
    ? "high-contrast"
    : "builtin";

test("every shipped theme clears its quality bar in both schemes", () => {
  assert.ok(BLOCKS.length >= 2);
  const failures = BLOCKS.flatMap((b) =>
    qualityReport(b.tokens, tierOf(b.palette))
      .filter((m) => !m.ok)
      .map(
        (m) =>
          `${b.palette} ${b.scheme}: ${m.rule}, ${m.where}: ${m.measured.toFixed(3)} < ${m.floor}`,
      ),
  );
  assert.deepEqual(failures, []);
});

test("every offered theme has both schemes in globals.css, and nothing else does", () => {
  // #505: a theme is offered (PALETTE_INFO) exactly when its blocks exist.
  const blocks = (scheme: string) =>
    BLOCKS.filter((b) => b.scheme === scheme)
      .map((b) => b.palette)
      .sort();
  const offered = PALETTE_INFO.map((p) => p.name).sort();
  assert.deepEqual(blocks("dark"), offered);
  assert.deepEqual(blocks("light"), offered);
});

test("a broken token fails and names its rule", () => {
  const dark = BLOCKS.find((b) => b.palette === "holotable" && b.scheme === "dark");
  assert.ok(dark);
  // The focus ring painted in the surface's own color.
  const broken = { ...dark.tokens, ring: dark.tokens.surface };
  const failed = qualityReport(broken).filter((m) => !m.ok);
  assert.ok(failed.some((m) => m.rule === "ring" && m.where === "ring on surface"));
  // Warning made a twin of danger.
  const merged = { ...dark.tokens, warning: dark.tokens.danger };
  assert.ok(qualityReport(merged).some((m) => m.rule === "status-distinct" && !m.ok));
});

test("the tiers: body text at AA for an operator, AAA built in, 12:1 in high contrast", () => {
  const hc = BLOCKS.find((b) => b.palette === "high-contrast" && b.scheme === "dark");
  assert.ok(hc);
  const floor = (tier: QualityTier, rule: string, where?: string) =>
    qualityReport(hc.tokens, tier).find(
      (m) => m.rule === rule && (!where || m.where === where),
    )?.floor;
  assert.equal(floor("operator", "foreground"), 4.5);
  assert.equal(floor("builtin", "foreground"), 7);
  assert.equal(floor("high-contrast", "foreground"), 12);
  // #506: every text at 7:1 and every edge at 4.5:1 in high contrast.
  assert.equal(floor("high-contrast", "muted"), 7);
  assert.equal(floor("high-contrast", "status-text"), 7);
  assert.equal(floor("high-contrast", "border", "border on surface"), 4.5);
  // And only there are tints solid, so only there is their ink measured.
  assert.ok(qualityReport(hc.tokens, "high-contrast").some((m) => m.rule === "tint-ink"));
  assert.ok(!qualityReport(hc.tokens, "builtin").some((m) => m.rule === "tint-ink"));
});

/*
 * The simulation is checked by its invariants, not against a published table:
 * the references round and clip differently, so their sRGB outputs cannot be
 * reproduced to the unit. Each Machado row sums to 1, so a neutral stays
 * neutral, and every deficiency still tells black from white.
 */
test("color-vision simulation keeps neutrals neutral", () => {
  for (const d of DEFICIENCIES) {
    for (const row of MACHADO[d]) {
      assert.ok(
        Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-3,
        `${d} row sums to 1`,
      );
    }
    for (const hex of ["#000000", "#ffffff", "#808080"]) {
      const rgb = hexToRgb(hex);
      assert.ok(deltaE(simulate(rgb, d), rgb) < 0.005, `${hex} under ${d}`);
    }
  }
});

test("color-vision simulation collapses the pair each deficiency confuses", () => {
  const red = hexToRgb("#ff0000");
  // A darker green, so the pair differs in hue rather than lightness.
  const green = hexToRgb("#008000");
  const normal = deltaE(red, green);
  // Red against green shrinks for protanopia and deuteranopia, much less for tritanopia.
  const protan = deltaE(simulate(red, "protanopia"), simulate(green, "protanopia"));
  const deutan = deltaE(simulate(red, "deuteranopia"), simulate(green, "deuteranopia"));
  const tritan = deltaE(simulate(red, "tritanopia"), simulate(green, "tritanopia"));
  assert.ok(
    protan < normal / 2 && deutan < normal / 2,
    `${protan} ${deutan} vs ${normal}`,
  );
  assert.ok(tritan > normal * 0.8, `${tritan} vs ${normal}`);
});
