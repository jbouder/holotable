import { test } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { BOOTSTRAP_SCRIPT } from "@/lib/bootstrap";
import {
  animateOut,
  DEFAULT_MOTION,
  DURATION_BASE_MS,
  EASE_EMPHASIZED,
  isMotion,
  isMotionActive,
  MOTIONS,
  resolveMotion,
} from "@/lib/motion";
import { withViewTransition } from "@/lib/view-transition";
// Installs a jsdom `document` for the helper tests; `boot()` below keeps its
// own fake page, so the two do not meet.
import "./support/dom";

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

/* ---------- The helpers (#234) ---------- */

test("isMotionActive reads the resolved attribute", () => {
  const root = document.documentElement;
  root.dataset.motion = "allow";
  assert.equal(isMotionActive(), true);
  root.dataset.motion = "reduce";
  assert.equal(isMotionActive(), false);
  delete root.dataset.motion;
});

test("withViewTransition runs the update synchronously when disabled", () => {
  let ran = false;
  withViewTransition(
    () => {
      ran = true;
    },
    false,
    "theme",
  );
  assert.equal(ran, true);
  assert.equal(document.documentElement.dataset.vt, undefined);
});

test("withViewTransition runs the update synchronously without startViewTransition", () => {
  // jsdom has no View Transitions API, which is exactly the browser case
  // being covered: the update must not wait on anything.
  assert.equal(typeof document.startViewTransition, "undefined");
  let ran = false;
  withViewTransition(() => {
    ran = true;
  }, true);
  assert.equal(ran, true);
  assert.equal(document.documentElement.dataset.vt, undefined);
});

test("withViewTransition scopes <html data-vt> to the life of the transition", async () => {
  const root = document.documentElement;
  const calls: string[] = [];
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const fake = (callback: () => void) => {
    calls.push(`vt=${root.dataset.vt}`);
    callback();
    return { ready: Promise.reject(new Error("skipped")), finished };
  };
  (document as unknown as { startViewTransition: unknown }).startViewTransition = fake;
  try {
    withViewTransition(() => calls.push("update"), true, "tab");
    assert.deepEqual(calls, ["vt=tab", "update"]);
    assert.equal(
      root.dataset.vt,
      "tab",
      "the type stays on <html> while the transition runs",
    );
    finish();
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.dataset.vt, undefined, "and is removed when it finishes");
  } finally {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  }
});

test("withViewTransition leaves a newer transition's type alone", async () => {
  const root = document.documentElement;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  (document as unknown as { startViewTransition: unknown }).startViewTransition = (
    callback: () => void,
  ) => {
    callback();
    return { ready: Promise.resolve(), finished };
  };
  try {
    withViewTransition(() => undefined, true, "theme");
    root.dataset.vt = "tab";
    finish();
    await finished;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(root.dataset.vt, "tab");
  } finally {
    delete root.dataset.vt;
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  }
});

test("animateOut resolves immediately when disabled and never touches the element", async () => {
  const el = {
    animate() {
      throw new Error("animate must not be called under Reduce");
    },
  } as unknown as HTMLElement;
  await animateOut(el, false);
});

test("animateOut fades, slides and holds the final frame when enabled", async () => {
  const recorded: { keyframes: unknown; options: unknown }[] = [];
  const el = {
    animate(keyframes: unknown, options: unknown) {
      recorded.push({ keyframes, options });
      return { finished: Promise.resolve() };
    },
  } as unknown as HTMLElement;
  await animateOut(el, true);
  assert.equal(recorded.length, 1);
  assert.deepEqual(recorded[0].options, {
    duration: DURATION_BASE_MS,
    easing: EASE_EMPHASIZED,
    fill: "forwards",
  });
  const frames = recorded[0].keyframes as Record<string, string | number>[];
  assert.equal(frames[0].opacity, 1);
  assert.equal(frames.at(-1)?.opacity, 0);
});
