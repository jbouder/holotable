import { test } from "node:test";
import assert from "node:assert/strict";
import { THEME_EVENT, THEME_STORAGE_KEY } from "@/lib/theme";
import { applyThemeWithTransition, setThemeWithTransition } from "@/lib/theme-transition";
// Installs a jsdom document; it has no View Transitions API, which is the
// fallback being pinned here.
import "./support/dom";

// `setTheme` dispatches a `CustomEvent`; jsdom only accepts its own Event
// classes, and the harness leaves Node's on the global.
(globalThis as unknown as { CustomEvent: unknown }).CustomEvent = window.CustomEvent;

/**
 * The theme crossfade (#236) wraps the DOM write in `withViewTransition`.
 * Without `document.startViewTransition` (jsdom, an older browser) or under
 * Reduce, the write must still happen, synchronously, and the preference must
 * still be stored and broadcast — the transition is decoration on top of
 * `src/lib/theme.ts`, never a precondition for it.
 */

function reset() {
  const root = document.documentElement;
  delete root.dataset.theme;
  delete root.dataset.vt;
  root.dataset.motion = "allow";
  window.localStorage.removeItem(THEME_STORAGE_KEY);
}

test("setThemeWithTransition applies, stores and broadcasts synchronously without the API", () => {
  reset();
  assert.equal(typeof document.startViewTransition, "undefined");
  let announced: string | null = null;
  const onTheme = (e: Event) => {
    announced = (e as CustomEvent<string>).detail;
  };
  window.addEventListener(THEME_EVENT, onTheme);
  try {
    setThemeWithTransition("light");
    assert.equal(document.documentElement.dataset.theme, "light");
    assert.equal(document.documentElement.style.colorScheme, "light");
    assert.equal(window.localStorage.getItem(THEME_STORAGE_KEY), "light");
    assert.equal(announced, "light");
    assert.equal(
      document.documentElement.dataset.vt,
      undefined,
      "no transition was started",
    );
  } finally {
    window.removeEventListener(THEME_EVENT, onTheme);
  }
});

test("applyThemeWithTransition writes the attribute but stores nothing", () => {
  reset();
  applyThemeWithTransition("dark");
  assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(window.localStorage.getItem(THEME_STORAGE_KEY), null);
});

test("under Reduce the write is immediate even when the API exists", () => {
  reset();
  document.documentElement.dataset.motion = "reduce";
  let started = false;
  (document as unknown as { startViewTransition: unknown }).startViewTransition = () => {
    started = true;
    return { ready: Promise.resolve(), finished: Promise.resolve() };
  };
  try {
    setThemeWithTransition("light");
    assert.equal(started, false);
    assert.equal(document.documentElement.dataset.theme, "light");
  } finally {
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition;
  }
});
