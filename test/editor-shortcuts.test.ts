import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findBinding,
  formatShortcut,
  isMacPlatform,
  isTextField,
  type KeyChord,
  matchesShortcut,
  type Shortcut,
} from "../src/lib/editor/use-shortcuts";

/**
 * Editor keyboard shortcuts (#121).
 *
 * The matcher takes a chord and a focus description rather than a DOM event,
 * so the two rules that decide whether a keystroke reaches the editor — the
 * platform modifier and the text-field suppression — are ordinary unit tests.
 */

function chord(partial: Partial<KeyChord> & { key: string }): KeyChord {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...partial,
  };
}

const save: Shortcut = {
  id: "save",
  key: "s",
  mod: true,
  inTextField: true,
  description: "Save",
  group: "Saving",
};
const redo: Shortcut = {
  id: "redo",
  key: "z",
  mod: true,
  shift: true,
  description: "Redo",
  group: "Editing",
};
const newPanel: Shortcut = {
  id: "new-panel",
  key: "n",
  description: "Add a panel",
  group: "Editing",
};

test("the primary modifier follows the platform", () => {
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("iPhone"), true);
  assert.equal(isMacPlatform("Win32"), false);
  assert.equal(isMacPlatform("Linux x86_64"), false);
  assert.equal(isMacPlatform(undefined), false);

  assert.equal(matchesShortcut(chord({ key: "s", metaKey: true }), save, true), true);
  assert.equal(matchesShortcut(chord({ key: "s", ctrlKey: true }), save, true), false);
  assert.equal(matchesShortcut(chord({ key: "s", ctrlKey: true }), save, false), true);
  assert.equal(matchesShortcut(chord({ key: "s", metaKey: true }), save, false), false);
});

test("the key comparison ignores case but the modifiers do not", () => {
  assert.equal(matchesShortcut(chord({ key: "S", metaKey: true }), save, true), true);
  assert.equal(matchesShortcut(chord({ key: "s" }), save, true), false);
  assert.equal(
    matchesShortcut(chord({ key: "s", metaKey: true, shiftKey: true }), save, true),
    false,
  );
  assert.equal(
    matchesShortcut(chord({ key: "z", metaKey: true, shiftKey: true }), redo, true),
    true,
  );
  assert.equal(matchesShortcut(chord({ key: "z", metaKey: true }), redo, true), false);
  assert.equal(matchesShortcut(chord({ key: "n", altKey: true }), newPanel, true), false);
});

test("text-entry elements are recognised, non-text inputs are not", () => {
  assert.equal(isTextField({ tagName: "TEXTAREA" }), true);
  assert.equal(isTextField({ tagName: "INPUT" }), true);
  assert.equal(isTextField({ tagName: "INPUT", type: "number" }), true);
  assert.equal(isTextField({ tagName: "INPUT", type: "checkbox" }), false);
  assert.equal(isTextField({ tagName: "DIV", isContentEditable: true }), true);
  assert.equal(isTextField({ tagName: "DIV" }), false);
  assert.equal(isTextField({ tagName: "BUTTON" }), false);
  assert.equal(isTextField(null), false);
});

test("a bare-letter binding does not fire while typing, a Cmd binding does", () => {
  const bindings = [save, newPanel];
  const inField = { mac: true, inTextField: true };
  assert.equal(findBinding(bindings, chord({ key: "n" }), inField), null);
  assert.equal(
    findBinding(bindings, chord({ key: "s", metaKey: true }), inField)?.id,
    "save",
  );
  assert.equal(
    findBinding(bindings, chord({ key: "n" }), { mac: true, inTextField: false })?.id,
    "new-panel",
  );
});

test("undo is suppressed inside a text field so the native one still works", () => {
  const undo: Shortcut = {
    id: "undo",
    key: "z",
    mod: true,
    description: "Undo",
    group: "Editing",
  };
  const context = { mac: true, inTextField: true };
  assert.equal(findBinding([undo], chord({ key: "z", metaKey: true }), context), null);
  assert.equal(
    findBinding([undo], chord({ key: "z", metaKey: true }), {
      mac: true,
      inTextField: false,
    })?.id,
    "undo",
  );
});

test("a punctuation binding fires whatever the layout does with Shift", () => {
  // `?` is Shift+/ on a US keyboard and unshifted on others; `event.key` is `?`
  // either way, so requiring one Shift state would break the binding on half
  // the keyboards in use.
  const help: Shortcut = {
    id: "help",
    key: "?",
    anyShift: true,
    description: "Show the shortcuts",
    group: "Help",
  };
  assert.equal(matchesShortcut(chord({ key: "?", shiftKey: true }), help, true), true);
  assert.equal(matchesShortcut(chord({ key: "?" }), help, true), true);
  // The modifier is still part of the binding.
  assert.equal(matchesShortcut(chord({ key: "?", metaKey: true }), help, true), false);
});

test("a disabled binding is skipped without shadowing the ones behind it", () => {
  const disabled = { ...redo, disabled: true, run: () => {} };
  const enabled = {
    ...redo,
    id: "redo-alt",
    disabled: false,
    run: () => {},
  };
  const context = { mac: true, inTextField: false };
  const chordZ = chord({ key: "z", metaKey: true, shiftKey: true });
  assert.equal(findBinding([disabled, enabled], chordZ, context)?.id, "redo-alt");
});

test("bindings read the way the platform writes them", () => {
  assert.equal(formatShortcut(save, true), "⌘S");
  assert.equal(formatShortcut(save, false), "Ctrl+S");
  assert.equal(formatShortcut(redo, true), "⌘⇧Z");
  assert.equal(formatShortcut(redo, false), "Ctrl+Shift+Z");
  assert.equal(formatShortcut(newPanel, false), "N");
  assert.equal(
    formatShortcut({ id: "esc", key: "Escape", description: "", group: "" }, false),
    "Esc",
  );
  // A key whose Shift is a keyboard-layout artefact renders as itself.
  assert.equal(
    formatShortcut(
      { id: "help", key: "?", anyShift: true, description: "", group: "" },
      true,
    ),
    "?",
  );
});
