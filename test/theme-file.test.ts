import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolveBlock } from "@/lib/color/contrast";
import {
  checkThemeFile,
  parseThemeFile,
  type ThemeFile,
  themeCss,
} from "@/lib/color/theme-file";
import { PALETTE_INFO } from "@/lib/theme";
import { exportTheme } from "../scripts/themes-export";

/*
 * An operator's theme file (#508) is numbers held to the operator bar, never
 * CSS. These hold the parse, the generated stylesheet and the check that
 * stops a production boot.
 */

const CSS = readFileSync(new URL("../src/app/globals.css", import.meta.url), "utf8");

function parsed(file: unknown): ThemeFile {
  const result = parseThemeFile(JSON.stringify(file));
  assert.ok(result.theme, result.problems.join("\n"));
  return result.theme;
}

test("every built-in theme exports as a file that passes the boot checks unchanged", () => {
  // High contrast flattens the surface ladder on purpose (#506), which the
  // operator tier asks for; it is held to its own tier instead.
  for (const { name } of PALETTE_INFO.filter((p) => !p.highContrast)) {
    const theme = parsed(exportTheme(CSS, name));
    assert.deepEqual(checkThemeFile(theme), [], name);
  }
});

test("a file is tokens in a closed shape: no built-in name, no stray key, no CSS", () => {
  const good = exportTheme(CSS, "graphite", "acme");
  assert.ok(parseThemeFile(JSON.stringify(good)).theme);
  const problems = (file: unknown) =>
    parseThemeFile(JSON.stringify(file)).problems.join("\n");
  assert.match(problems({ ...good, name: "paper" }), /built-in/);
  assert.match(problems({ ...good, name: "Acme Corp" }), /^name /);
  assert.match(problems({ ...good, logo: "x.png" }), /logo|Unrecognized/i);
  assert.match(
    problems({ ...good, dark: { ...good.dark, extra: "#000000" } }),
    /dark|Unrecognized/i,
  );
  // A value that tries to close the declaration is not a color.
  for (const value of [
    "red",
    "#fff",
    "oklch(0.5 0.1 200); } body { color: red",
    "url(x)",
  ]) {
    assert.match(
      problems({ ...good, light: { ...good.light, primary: value } }),
      /light\.primary/,
      value,
    );
  }
  assert.match(problems({ ...good, radius: "1rem" }), /radius/);
  assert.match(parseThemeFile("{").problems.join(""), /not JSON/);
});

test("the stylesheet is only declarations under the theme's two selectors", () => {
  const theme = parsed({ ...exportTheme(CSS, "paper", "acme"), radius: "4px" });
  const css = themeCss(theme);
  const block = String.raw`\[data-palette="acme"\]\[data-theme="(?:dark|light)"\]\{(?:--[a-z0-9-]+:[#a-z0-9. ()]+;)+\}`;
  assert.match(css, new RegExp(`^${block}\\n${block}$`));
  // Parsed back, it is the file's colors.
  const dark = /\[data-theme="dark"\]\{([^}]*)\}/.exec(css)?.[1] ?? "";
  const decls = Object.fromEntries(
    dark
      .split(";")
      .filter(Boolean)
      .map((d) => d.slice(2).split(":") as [string, string]),
  );
  assert.equal(decls.radius, "4px");
  const parsedBack = parsed({ ...exportTheme(CSS, "paper", "acme") });
  assert.deepEqual(
    resolveBlock(decls).tokens.primary,
    resolveBlock({ primary: themeCss(parsedBack).match(/--primary:([^;]+);/)?.[1] ?? "" })
      .tokens.primary,
  );
});

test("a theme below the bar fails, naming the pairing, the scheme and the number", () => {
  const file = exportTheme(CSS, "graphite", "acme");
  // Muted text too light for the light scheme's inset surface.
  const theme = parsed({
    ...file,
    light: { ...file.light, muted: "oklch(0.62 0.006 70)" },
  });
  const failures = checkThemeFile(theme);
  assert.ok(
    failures.some((f) =>
      /muted on (bg-)?surface-2, light: \d\.\d\d(:1)? \(needs 4\.5/.test(f),
    ),
    failures.join("\n"),
  );
});

test("the docs' example is what the export writes, so it always loads", () => {
  const doc = readFileSync(
    new URL("../docs/src/content/docs/admin/themes.md", import.meta.url),
    "utf8",
  );
  assert.ok(doc.includes(JSON.stringify(exportTheme(CSS, "graphite", "acme"), null, 2)));
});
