import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The "Motion rules" in AGENTS.md, as far as a file scan can hold them
 * (#239). None of these would fail a build or a render: a `duration-150`
 * works, `motion-safe:` works, and an animation library would import fine.
 * They would just quietly make one surface disagree with the preference in
 * `src/lib/motion.ts`, which is the one thing the whole motion system
 * promises not to do.
 */

const SRC = join(process.cwd(), "src");

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else if (/\.(tsx?|css)$/.test(name)) yield path;
  }
}

const sources = [...files(SRC)].map((path) => ({
  path: path.slice(process.cwd().length + 1),
  text: readFileSync(path, "utf8"),
}));

/** Lines of code only: a comment may name a rule in order to explain it. */
function codeLines(text: string): string[] {
  return text.split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line));
}

function offenders(pattern: RegExp): string[] {
  return sources.flatMap(({ path, text }) =>
    codeLines(text)
      .filter((line) => pattern.test(line))
      .map((line) => `${path}: ${line.trim()}`),
  );
}

test("no component keys motion off the OS media query; data-motion is the only switch", () => {
  assert.deepEqual(offenders(/\bmotion-(safe|reduce):/), []);
  // The skeleton's `prefers-reduced-motion` fallback in globals.css is the one
  // documented exception: it is what applies when the bootstrap script is
  // blocked and `<html data-motion>` is missing. Nothing else may add one.
  const media = offenders(/prefers-reduced-motion/).filter(
    (line) => !line.startsWith("src/lib/motion.ts:"),
  );
  assert.deepEqual(media, [
    "src/app/globals.css: @media (prefers-reduced-motion: no-preference) {",
  ]);
});

test("durations and curves are tokens, not literals", () => {
  assert.deepEqual(offenders(/\bduration-\d+\b/), []);
  assert.deepEqual(offenders(/\bease-(in|out|in-out|linear)\b/), []);
});

test("no animation library is imported", () => {
  assert.deepEqual(
    offenders(
      /from\s+["'](framer-motion|motion|motion\/react|react-spring|@react-spring\/\w+|@formkit\/auto-animate|tw-animate-css)["']/,
    ),
    [],
  );
  assert.deepEqual(offenders(/tw-animate-css/), []);
});

test("every view-transition name is scoped to a data-vt type with the html selector", () => {
  const css = sources.find((s) => s.path === "src/app/globals.css");
  assert.ok(css);
  const lines = css.text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (!/view-transition-name:/.test(line)) continue;
    // The rule's selector is the nearest preceding line that opens a block.
    const selector = lines
      .slice(0, i)
      .reverse()
      .find((l) => l.trim().endsWith("{"));
    assert.match(selector ?? "", /^html\[data-vt="[a-z]+"\]/, `${line.trim()} is scoped`);
  }
});
