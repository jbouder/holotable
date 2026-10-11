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
