import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  AA_TEXT,
  contrastRatio,
  contrastTable,
  hexToRgb,
  measureContrast,
  over,
  parseThemeTokens,
} from "@/lib/color/contrast";

/*
 * The design tokens against WCAG AA (#77). Every pairing the interface uses
 * (src/lib/color/contrast.ts) is measured in both themes from the tokens as
 * they are in globals.css, so a lightness tweak that drops one below 4.5:1
 * fails here, naming the pairing, before a reader meets it.
 */

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

test("the contrast math matches WCAG's reference values", () => {
  assert.equal(
    contrastRatio(hexToRgb("#000000"), hexToRgb("#ffffff")).toFixed(1),
    "21.0",
  );
  assert.equal(
    contrastRatio(hexToRgb("#777777"), hexToRgb("#ffffff")).toFixed(2),
    "4.48",
  );
  // Order does not matter.
  assert.equal(
    contrastRatio(hexToRgb("#ffffff"), hexToRgb("#777777")),
    contrastRatio(hexToRgb("#777777"), hexToRgb("#ffffff")),
  );
});

test("a tint composites over its background the way the browser paints it", () => {
  // What axe measured for `bg-success/20` over white before #77.
  assert.deepEqual(over(hexToRgb("#008c4f"), 0.2, hexToRgb("#ffffff")), [204, 232, 220]);
});

test("both theme blocks resolve every color token", () => {
  const themes = parseThemeTokens(CSS);
  for (const theme of ["dark", "light"] as const) {
    for (const token of [
      "background",
      "surface",
      "surface-2",
      "surface-3",
      "foreground",
      "muted",
      "primary",
      "primary-foreground",
      "danger",
      "warning",
      "success",
    ]) {
      assert.ok(themes[theme][token], `--${token} missing from the ${theme} theme`);
    }
  }
});

test("the accessibility docs carry the ratios the tokens actually produce", () => {
  const doc = readFileSync(
    new URL("../docs/src/content/docs/architecture/accessibility.md", import.meta.url),
    "utf8",
  );
  assert.ok(
    doc.includes(contrastTable(CSS)),
    "docs/src/content/docs/architecture/accessibility.md is out of date: paste contrastTable(globals.css) from src/lib/color/contrast.ts",
  );
});

test("every text pairing meets AA in both themes", () => {
  const failing = measureContrast(CSS)
    .filter((m) => m.ratio < (m.floor ?? AA_TEXT))
    .map((m) => `${m.theme}: ${m.where} is ${m.ratio.toFixed(2)}:1`);
  assert.deepEqual(failing, []);
});

test("another palette's blocks are measured on top of Holotable's", () => {
  // #503: a second theme is `[data-palette][data-theme]`, overriding what it
  // sets; the table grows a section per theme.
  const css = `${CSS}
[data-palette="graphite"][data-theme="dark"] {
  --surface: oklch(0.2 0 0);
}
[data-palette="graphite"][data-theme="light"] {
  --surface: oklch(0.99 0 0);
}`;
  const graphite = measureContrast(css).filter((m) => m.palette === "graphite");
  assert.equal(graphite.length, measureContrast(CSS).length);
  assert.match(contrastTable(css), /### holotable[\s\S]*### graphite/);
});
