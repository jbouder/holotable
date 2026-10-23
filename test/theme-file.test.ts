import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseThemeDecls, resolveBlock } from "@/lib/color/contrast";
import {
  checkThemeFile,
  OPTIONAL_THEME_FILE_TOKENS,
  parseThemeFile,
  SHADOWS,
  THEME_FILE_TOKENS,
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
  assert.match(problems({ ...good, shadow: "0 0 4px red" }), /shadow/);
  // A value too long to write back as plain decimal is refused, not crashed on.
  assert.match(
    problems({ ...good, dark: { ...good.dark, ring: "oklch(0.0000001 0 0)" } }),
    /dark\.ring/,
  );
  assert.match(parseThemeFile("{").problems.join(""), /not JSON/);
});

test("the stylesheet is only declarations under the theme's two selectors", () => {
  const theme = parsed({ ...exportTheme(CSS, "paper", "acme"), radius: "4px" });
  const css = themeCss(theme);
  // Values are numbers the file gave, or the fixed card shadows and grid
  // fallback (#648): never a brace, a semicolon or a quote.
  const block = String.raw`\[data-palette="acme"\]\[data-theme="(?:dark|light)"\]\{(?:--[a-z0-9-]+:[#a-z0-9. ()/,-]+;)+\}`;
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

test("Holotable exports and loads as it paints; a file that names no look keeps the old one", () => {
  // #648: the default's corners, card lift and gridlines are its own, not
  // aliases, so its export carries them and the stylesheet writes them back.
  const decls = (css: string, scheme: "dark" | "light") =>
    Object.fromEntries(
      (new RegExp(`\\[data-theme="${scheme}"\\]\\{([^}]*)\\}`).exec(css)?.[1] ?? "")
        .split(";")
        .filter(Boolean)
        .map((d) => {
          const at = d.indexOf(":");
          return [d.slice(2, at), d.slice(at + 1)];
        }),
    );
  const builtIn = (scheme: "dark" | "light") =>
    parseThemeDecls(CSS).find((b) => b.palette === "holotable" && b.scheme === scheme)
      ?.decls ?? {};
  const copy = themeCss(parsed(exportTheme(CSS, "holotable", "acme")));
  for (const scheme of ["dark", "light"] as const) {
    const ours = decls(copy, scheme);
    const theirs = resolveBlock(builtIn(scheme)).tokens;
    const back = resolveBlock(ours).tokens;
    for (const t of [...THEME_FILE_TOKENS, ...Object.keys(OPTIONAL_THEME_FILE_TOKENS)]) {
      assert.deepEqual(back[t], theirs[t], `${scheme} --${t}`);
    }
    assert.equal(ours.radius, builtIn(scheme).radius);
    assert.equal(ours["shadow-card"], builtIn(scheme)["shadow-card"]);
  }
  // A file from before #648 (graphite's export names neither) is square,
  // subtly lifted and gridded in its inset surface, as every such file was.
  const old = themeCss(parsed(exportTheme(CSS, "graphite", "acme")));
  for (const scheme of ["dark", "light"] as const) {
    const d = decls(old, scheme);
    assert.equal(d.radius, "0px");
    assert.equal(d["shadow-card"], SHADOWS.subtle[scheme]);
    assert.equal(d["chart-grid"], "var(--surface-2)");
  }
  // #641: a file that does not split its amber fills them in its text colors,
  // and one that does is written and measured with its own fill.
  const unsplit = parsed(exportTheme(CSS, "graphite", "acme"));
  delete unsplit.light["warning-fill"];
  delete unsplit.light["orange-fill"];
  const plain = decls(themeCss(unsplit), "light");
  assert.equal(plain["warning-fill"], "var(--warning)");
  assert.equal(plain["orange-fill"], "var(--orange)");
  assert.deepEqual(checkThemeFile(unsplit), []);
  const split = decls(old, "light");
  assert.match(split["warning-fill"], /^oklch\(/);
  assert.notEqual(split["orange-fill"], split.orange);
});

test("every built-in theme's card shadow is one a theme file can name", () => {
  for (const { palette, scheme, decls } of parseThemeDecls(CSS)) {
    assert.ok(
      Object.values(SHADOWS).some((s) => s[scheme] === decls["shadow-card"]),
      `${palette} ${scheme}: --shadow-card`,
    );
  }
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
