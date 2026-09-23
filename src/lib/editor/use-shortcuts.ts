"use client";

import * as React from "react";

/**
 * Scoped keyboard shortcuts (#121). What exists is declared in
 * `src/lib/shortcuts.ts` (#217); this module matches, formats and binds.
 *
 * The editor is a tool people iterate in, so reaching for the Save button and
 * clicking a send icon adds up. Everything here is additive: every action a
 * shortcut reaches is still reachable by pointer, which is what keeps the
 * bindings an accelerator rather than a hidden interface.
 *
 * The matching rules are pure functions over a key-event *shape* rather than a
 * real `KeyboardEvent`, so `test/editor-shortcuts.test.ts` can exercise the
 * platform modifier and the text-field suppression without a DOM.
 */

/** The subset of `KeyboardEvent` the matcher reads. */
export interface KeyChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface Shortcut {
  /** Stable id, also the React key in the `?` overlay. */
  id: string;
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** Cmd on macOS, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
  /**
   * Ignore the Shift key entirely.
   *
   * For a punctuation binding the character IS the binding: `?` is Shift+/ on a
   * US keyboard, Shift+ß on a German one, and unshifted on layouts that have it
   * on its own key. `event.key` is already `?` in every case, so insisting on a
   * particular Shift state only makes the binding fail on some keyboards.
   */
  anyShift?: boolean;
  /**
   * Fire even when focus is inside a text field. Off by default: a bare letter
   * binding must never eat a character someone is typing.
   */
  inTextField?: boolean;
  /**
   * What to print instead of the key, for an entry that stands for a family of
   * keys ("Arrow keys"). Modifiers are still printed in front of it.
   */
  keysLabel?: string;
  /** What the binding does, for the `?` overlay and the button tooltips. */
  description: string;
  /** Heading the overlay groups it under. */
  group: string;
}

export interface Binding extends Shortcut {
  run: () => void;
  /** Skip the binding without removing it from the overlay. */
  disabled?: boolean;
}

/** Whether the platform uses Cmd rather than Ctrl as the primary modifier. */
export function isMacPlatform(platform: string | undefined): boolean {
  return /mac|iphone|ipad|ipod/i.test(platform ?? "");
}

/** The shape of a focused element the suppression rule needs. */
export interface FocusTarget {
  tagName: string;
  isContentEditable?: boolean;
  type?: string;
}

/**
 * Non-text `<input>` types. A checkbox or a radio does not swallow characters,
 * so a bare-letter binding is safe while one is focused; a text box is not.
 */
const NON_TEXT_INPUT_TYPES = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

export function isTextField(target: FocusTarget | null): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  if (tag === "textarea") return true;
  if (tag === "select") return true;
  if (tag !== "input") return false;
  return !NON_TEXT_INPUT_TYPES.has((target.type ?? "text").toLowerCase());
}

export function matchesShortcut(
  chord: KeyChord,
  shortcut: Shortcut,
  mac: boolean,
): boolean {
  if (chord.key.toLowerCase() !== shortcut.key.toLowerCase()) return false;
  const mod = mac ? chord.metaKey : chord.ctrlKey;
  // The modifier that is NOT primary on this platform must be up, so Ctrl+S on
  // a Mac does not fire a binding declared as Cmd+S.
  const otherMod = mac ? chord.ctrlKey : chord.metaKey;
  if (mod !== Boolean(shortcut.mod)) return false;
  if (otherMod) return false;
  if (!shortcut.anyShift && chord.shiftKey !== Boolean(shortcut.shift)) return false;
  if (chord.altKey !== Boolean(shortcut.alt)) return false;
  return true;
}

/**
 * The binding a chord should run, or null.
 *
 * `inTextField` is the caller's answer to "is focus in something that eats
 * characters?" — computed from the event target by the hook, supplied directly
 * by the tests.
 */
export function findBinding<T extends Shortcut & { disabled?: boolean }>(
  bindings: T[],
  chord: KeyChord,
  context: { mac: boolean; inTextField: boolean },
): T | null {
  for (const binding of bindings) {
    if (binding.disabled) continue;
    if (context.inTextField && !binding.inTextField) continue;
    if (matchesShortcut(chord, binding, context.mac)) return binding;
  }
  return null;
}

const KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  "?": "?",
  "/": "/",
};

/** The binding as people read it: `⌘S` on a Mac, `Ctrl+S` elsewhere. */
export function formatShortcut(shortcut: Shortcut, mac: boolean): string {
  const parts: string[] = [];
  if (shortcut.mod) parts.push(mac ? "⌘" : "Ctrl");
  if (shortcut.shift) parts.push(mac ? "⇧" : "Shift");
  if (shortcut.alt) parts.push(mac ? "⌥" : "Alt");
  if (shortcut.keysLabel) {
    parts.push(shortcut.keysLabel);
    // A word after a Mac glyph reads as one token ("⇧Arrow keys"); space it.
    return mac ? parts.join(parts.length > 1 ? " " : "") : parts.join("+");
  }
  const lower = shortcut.key.toLowerCase();
  parts.push(KEY_LABELS[lower] ?? shortcut.key.toUpperCase());
  return mac ? parts.join("") : parts.join("+");
}

/**
 * Register the bindings on the window for as long as the component is mounted.
 *
 * The bindings live in a ref so a re-render with fresh closures does not
 * detach and re-attach the listener — the handler always calls the latest
 * `run` without the listener itself depending on it.
 */
export function useShortcuts(bindings: Binding[], enabled = true): void {
  const mac = useIsMac();
  const latest = React.useRef(bindings);
  React.useEffect(() => {
    latest.current = bindings;
  });

  React.useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as (HTMLElement & { type?: string }) | null;
      const binding = findBinding(latest.current, event, {
        mac,
        inTextField: isTextField(
          target
            ? {
                tagName: target.tagName,
                isContentEditable: target.isContentEditable,
                type: target.type,
              }
            : null,
        ),
      });
      if (!binding) return;
      // Cmd/Ctrl+S in particular must not reach the browser's save dialog.
      event.preventDefault();
      binding.run();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, mac]);
}

/**
 * Whether this browser uses Cmd. Resolved after mount: the server has no
 * platform, and rendering `⌘` or `Ctrl` during SSR would be a hydration
 * mismatch on half the machines that load the page.
 */
export function useIsMac(): boolean {
  const [mac, setMac] = React.useState(false);
  React.useEffect(() => {
    setMac(isMacPlatform(navigator.platform || navigator.userAgent));
  }, []);
  return mac;
}
