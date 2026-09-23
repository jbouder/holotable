import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { BOOTSTRAP_SCRIPT } from "@/lib/bootstrap";
import { DEFAULT_MOTION, isMotion, MOTIONS, resolveMotion } from "@/lib/motion";

test("Follow system honours prefers-reduced-motion; an explicit choice ignores it", () => {
  assert.equal(resolveMotion("system", true), "reduce");
  assert.equal(resolveMotion("system", false), "allow");
  for (const system of [true, false]) {
    assert.equal(resolveMotion("reduce", system), "reduce");
    assert.equal(resolveMotion("allow", system), "allow");
  }
});

test("only the three known values are motion preferences", () => {
  assert.deepEqual([...MOTIONS], ["system", "reduce", "allow"]);
  assert.equal(DEFAULT_MOTION, "system");
  for (const bad of [null, undefined, "", "none", "Reduce"])
    assert.equal(isMotion(bad), false);
});

/** Run the bootstrap script against a fake page, as the browser would in <head>. */
function boot(opts: {
  stored?: Record<string, string>;
  dark?: boolean;
  reduced?: boolean;
  storageThrows?: boolean;
}) {
  const dataset: Record<string, string> = {};
  const style: Record<string, string> = {};
  const localStorage = {
    getItem(key: string) {
      if (opts.storageThrows) throw new Error("SecurityError");
      return opts.stored?.[key] ?? null;
    },
  };
  const matchMedia = (query: string) => ({
    matches: query.includes("color-scheme: dark")
      ? Boolean(opts.dark)
      : query.includes("reduced-motion: reduce")
        ? Boolean(opts.reduced)
        : false,
  });
  runInNewContext(BOOTSTRAP_SCRIPT, {
    document: { documentElement: { dataset, style } },
    localStorage,
    matchMedia,
  });
  return { theme: dataset.theme, motion: dataset.motion, colorScheme: style.colorScheme };
}

test("the bootstrap script resolves both stored preferences before first paint", () => {
  assert.deepEqual(boot({ stored: { theme: "light", motion: "reduce" } }), {
    theme: "light",
    motion: "reduce",
    colorScheme: "light",
  });
  assert.equal(boot({ stored: { motion: "allow" }, reduced: true }).motion, "allow");
});

test("with nothing stored, the theme defaults to dark and motion follows the OS", () => {
  assert.deepEqual(boot({ reduced: true }), {
    theme: "dark",
    motion: "reduce",
    colorScheme: "dark",
  });
  assert.equal(boot({ reduced: false }).motion, "allow");
  assert.equal(boot({ stored: { theme: "system" }, dark: false }).theme, "light");
});

test("an unknown stored value falls back to the default rather than being applied", () => {
  const out = boot({ stored: { theme: "neon", motion: "sometimes" }, reduced: true });
  assert.equal(out.theme, "dark");
  assert.equal(out.motion, "reduce");
});

test("unreadable storage leaves the server's attributes alone and does not throw", () => {
  assert.deepEqual(boot({ storageThrows: true }), {
    theme: undefined,
    motion: undefined,
    colorScheme: undefined,
  });
});
