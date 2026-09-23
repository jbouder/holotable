import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatShortcut } from "@/lib/editor/use-shortcuts";
import {
  bindShortcuts,
  EDITOR_SHORTCUTS,
  FIELD_SHORTCUTS,
  PALETTE_SHORTCUT,
  PANEL_EXIT_SHORTCUT,
  SHORTCUT_SECTIONS,
} from "@/lib/shortcuts";

const SRC = new URL("../src/", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("every window- or document-level key binding goes through the registry", () => {
  const registry = join(SRC, "lib/shortcuts.ts");
  const hook = join(SRC, "lib/editor/use-shortcuts.ts");
  const offenders: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (file === registry || file === hook) continue;
    const text = readFileSync(file, "utf8");
    const binds =
      /(window|document)\.addEventListener\(\s*["']keydown["']/.test(text) ||
      /\buseShortcuts\(/.test(text);
    if (binds && !text.includes('from "@/lib/shortcuts"')) {
      offenders.push(file.slice(SRC.length));
    }
  }
  assert.deepEqual(offenders, [], "these bind keys globally without the registry");
});

test("the settings page lists every registered shortcut, each id once per section", () => {
  const listed = SHORTCUT_SECTIONS.flatMap((s) => s.shortcuts);
  for (const shortcut of [
    PALETTE_SHORTCUT,
    PANEL_EXIT_SHORTCUT,
    ...EDITOR_SHORTCUTS,
    ...FIELD_SHORTCUTS,
  ]) {
    assert.ok(listed.includes(shortcut), `${shortcut.id} is not on the settings page`);
  }
  for (const section of SHORTCUT_SECTIONS) {
    const ids = section.shortcuts.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${section.title}`);
  }
  assert.equal(
    new Set(SHORTCUT_SECTIONS.map((s) => s.id)).size,
    SHORTCUT_SECTIONS.length,
  );
});

test("no two editor bindings answer the same chord", () => {
  const chords = EDITOR_SHORTCUTS.map((s) => formatShortcut(s, false));
  assert.equal(new Set(chords).size, chords.length, chords.join(", "));
});

test("bindShortcuts attaches each action to its registry entry, keys unchanged", () => {
  const ran: string[] = [];
  const actions = Object.fromEntries(
    EDITOR_SHORTCUTS.map((s) => [
      s.id,
      {
        run: () => {
          ran.push(s.id);
        },
        disabled: s.id === "undo",
      },
    ]),
  ) as unknown as Parameters<typeof bindShortcuts<typeof EDITOR_SHORTCUTS>>[1];
  const bindings = bindShortcuts(EDITOR_SHORTCUTS, actions);
  assert.equal(bindings.length, EDITOR_SHORTCUTS.length);
  for (const [i, binding] of bindings.entries()) {
    assert.equal(binding.key, EDITOR_SHORTCUTS[i].key);
    assert.equal(binding.description, EDITOR_SHORTCUTS[i].description);
    binding.run();
  }
  assert.deepEqual(
    ran,
    EDITOR_SHORTCUTS.map((s) => s.id),
  );
  assert.equal(bindings.find((b) => b.id === "undo")?.disabled, true);
});

test("an editor binding cannot be left out, or added, without the compiler noticing", () => {
  // Checked by `npm run typecheck`, not at run time: each line must fail to compile.
  const run = () => {};
  // @ts-expect-error every registered shortcut needs an action
  void (() => bindShortcuts(EDITOR_SHORTCUTS, { save: { run } }));
  const all = Object.fromEntries(EDITOR_SHORTCUTS.map((s) => [s.id, { run }])) as Record<
    (typeof EDITOR_SHORTCUTS)[number]["id"],
    { run: () => void }
  >;
  // @ts-expect-error an action with no registry entry is rejected
  void (() => bindShortcuts(EDITOR_SHORTCUTS, { ...all, unlisted: { run } }));
});

test("chords show ⌘ on macOS and Ctrl elsewhere, and a key family by its label", () => {
  assert.equal(formatShortcut(PALETTE_SHORTCUT, true), "⌘K");
  assert.equal(formatShortcut(PALETTE_SHORTCUT, false), "Ctrl+K");
  const resize = FIELD_SHORTCUTS.find((s) => s.id === "grid-resize");
  assert.ok(resize);
  assert.equal(formatShortcut(resize, true), "⇧ Arrow keys");
  assert.equal(formatShortcut(resize, false), "Shift+Arrow keys");
  const move = FIELD_SHORTCUTS.find((s) => s.id === "grid-move");
  assert.ok(move);
  assert.equal(formatShortcut(move, true), "Arrow keys");
});
