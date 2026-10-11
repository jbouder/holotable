import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

/*
 * Every color is a token (#502). A literal in a component or a chart builder
 * is one color in both schemes, which is how the light scheme's charts ended
 * up with the dark scheme's gray text. Colors are defined in `globals.css` and
 * converted in `src/lib/color/`; everywhere else reads them from there.
 */
const ROOT = join(import.meta.dirname, "..", "src");
const ALLOWED = ["lib/color/", "app/globals.css"];
/** A quoted hex color, or a color function: what a stray literal looks like. */
const LITERAL = /["'`]#[0-9a-fA-F]{3,8}["'`]|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/;

test("no color literal outside the token layer", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(ROOT, path);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/.test(name) && !ALLOWED.some((a) => rel.startsWith(a))) {
        readFileSync(path, "utf8")
          .split("\n")
          .forEach((line, i) => {
            // Comments may name a color, as this one names `#ff0000` below.
            const code = line.replace(/\/\/.*$|^\s*\*.*$|\/\*.*?\*\//g, "");
            if (LITERAL.test(code)) found.push(`${rel}:${i + 1}: ${line.trim()}`);
          });
      }
    }
  };
  walk(ROOT);
  assert.deepEqual(found, []);
});

/** Every source file under `src/` outside `skip`, as `[relative path, text]`. */
function sources(skip: string[] = []): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const rel = relative(ROOT, path);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !skip.some((a) => rel.startsWith(a))) {
        out.push([rel, readFileSync(path, "utf8")]);
      }
    }
  };
  walk(ROOT);
  return out;
}

test("a status tint goes through the tint tokens", () => {
  // #506: `bg-danger/10` is one alpha in every theme; high contrast needs it
  // solid. A tint is `tinted bg-tint-<status>/(--tint-<n>)`, which a theme can
  // make solid, with the text inside on the tint ink. A hover or highlight
  // tint is not a notice and may stay as it is.
  const bare = /(?<![:\w/-])bg-(?:success|warning|danger)\/\d+/;
  const found = sources(["lib/color/"]).flatMap(([rel, text]) =>
    text
      .split("\n")
      .flatMap((line, i) => (bare.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : [])),
  );
  assert.deepEqual(found, []);
});

test("no component decides by theme", () => {
  // #506: a theme changes tokens, never markup. Components read no palette
  // name and no high-contrast flag; the theme controls are the exception.
  const decides = /["'`]high-contrast["'`]|\.highContrast\b|dataset\.palette\s*[!=]==/;
  const found = sources(["lib/"])
    .filter(
      ([rel, text]) => !rel.startsWith("components/theme-toggle") && decides.test(text),
    )
    .map(([rel]) => rel);
  assert.deepEqual(found, []);
});
