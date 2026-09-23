import type { Binding, Shortcut } from "@/lib/editor/use-shortcuts";

/**
 * Every keyboard shortcut Holotable binds, in one place (#217).
 *
 * The editor's `?` overlay, the `/settings/shortcuts` page and the code that
 * binds the keys all read these lists, so a shortcut cannot exist without
 * being listed, or be listed differently in two places. The editor binds its
 * list through {@link bindShortcuts}, whose type demands an action for every
 * id and accepts no other; the window-level listeners elsewhere compare
 * against the entry they own. `test/shortcuts.test.ts` fails if a file
 * registers a global key listener without going through this module.
 *
 * Kept free of `"use client"` so the settings page, a server component, can
 * import the data.
 */

export interface ShortcutSection {
  id: "global" | "viewer" | "editor" | "fields";
  title: string;
  description: string;
  shortcuts: readonly Shortcut[];
}

/** Opens and closes the command palette, from any page. */
export const PALETTE_SHORTCUT = {
  id: "palette",
  key: "k",
  mod: true,
  inTextField: true,
  group: "Navigation",
  description: "Open or close the command palette",
} as const satisfies Shortcut;

/** Leaves a panel's fullscreen view. */
export const PANEL_EXIT_SHORTCUT = {
  id: "panel-exit-fullscreen",
  key: "Escape",
  inTextField: true,
  group: "Panels",
  description: "Leave a panel's fullscreen view",
} as const satisfies Shortcut;

/** The dashboard editor's bindings (#121), bound by {@link bindShortcuts}. */
export const EDITOR_SHORTCUTS = [
  {
    id: "save",
    key: "s",
    mod: true,
    inTextField: true,
    group: "Saving",
    description: "Save a version and keep editing",
  },
  {
    id: "save-view",
    key: "s",
    mod: true,
    shift: true,
    inTextField: true,
    group: "Saving",
    description: "Save and view the dashboard",
  },
  { id: "undo", key: "z", mod: true, group: "Editing", description: "Undo" },
  { id: "redo", key: "z", mod: true, shift: true, group: "Editing", description: "Redo" },
  { id: "new-panel", key: "n", group: "Editing", description: "Add a panel" },
  {
    id: "duplicate-panel",
    key: "d",
    group: "Editing",
    description: "Duplicate the selected panel",
  },
  {
    id: "run",
    key: "Enter",
    mod: true,
    inTextField: true,
    group: "Editing",
    description: "Apply the natural-language edit (run the preview in the SQL box)",
  },
  {
    id: "focus-prompt",
    key: "/",
    group: "Editing",
    description: "Focus the natural-language prompt",
  },
  {
    id: "dismiss",
    key: "Escape",
    group: "Editing",
    description: "Dismiss the generated panel under review",
  },
  {
    id: "shortcuts",
    key: "?",
    anyShift: true,
    group: "Help",
    description: "Show this list",
  },
] as const satisfies readonly Shortcut[];

export type EditorShortcutId = (typeof EDITOR_SHORTCUTS)[number]["id"];

/**
 * Keys handled by one focused control rather than the window: listed so they
 * can be found, never bound from here.
 */
export const FIELD_SHORTCUTS = [
  {
    id: "prompt-send",
    key: "Enter",
    inTextField: true,
    group: "Prompts and chat",
    description: "Send the prompt (Shift+Enter starts a new line)",
  },
  {
    id: "sql-run",
    key: "Enter",
    mod: true,
    inTextField: true,
    group: "SQL editor",
    description: "Run the query preview",
  },
  {
    id: "grid-move",
    key: "ArrowRight",
    keysLabel: "Arrow keys",
    group: "Layout grid",
    description: "Move the focused panel",
  },
  {
    id: "grid-resize",
    key: "ArrowRight",
    shift: true,
    keysLabel: "Arrow keys",
    group: "Layout grid",
    description: "Resize the focused panel",
  },
  {
    id: "palette-move",
    key: "ArrowDown",
    keysLabel: "↑ ↓",
    group: "Command palette",
    description: "Move through the results",
  },
  {
    id: "palette-run",
    key: "Enter",
    group: "Command palette",
    description: "Run the highlighted command",
  },
] as const satisfies readonly Shortcut[];

export const SHORTCUT_SECTIONS: readonly ShortcutSection[] = [
  {
    id: "global",
    title: "Everywhere",
    description: "Work on any page while you are signed in.",
    shortcuts: [PALETTE_SHORTCUT],
  },
  {
    id: "viewer",
    title: "Dashboards",
    description: "While viewing a dashboard.",
    shortcuts: [PANEL_EXIT_SHORTCUT],
  },
  {
    id: "editor",
    title: "Dashboard editor",
    description: "While editing a dashboard. Press ? there to see this list.",
    shortcuts: EDITOR_SHORTCUTS,
  },
  {
    id: "fields",
    title: "In a focused control",
    description: "Handled by the box or list that has focus.",
    shortcuts: FIELD_SHORTCUTS,
  },
];

export interface ShortcutAction {
  run: () => void;
  /** Skip the binding without removing it from the overlay. */
  disabled?: boolean;
}

/**
 * Turn registry entries into live bindings. `actions` must name every entry,
 * and nothing else, which is what keeps a binding from existing unlisted.
 */
export function bindShortcuts<const T extends readonly Shortcut[]>(
  shortcuts: T,
  actions: { [Id in T[number]["id"]]: ShortcutAction },
): Binding[] {
  const byId = actions as Record<string, ShortcutAction>;
  return shortcuts.map((shortcut) => ({ ...shortcut, ...byId[shortcut.id] }));
}
