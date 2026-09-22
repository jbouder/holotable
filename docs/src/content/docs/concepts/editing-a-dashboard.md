---
title: Editing a dashboard
description: What an editing session holds, when it is written, and what happens to work that is never saved.
sidebar:
  order: 6
---

The editor (`src/app/dashboards/[id]/edit/`) is the only place a dashboard spec
changes. Everything it does happens in the browser until you press Save; a save
is the one moment a new `dashboard_versions` row is written, and it is the only
moment the server re-validates the spec and re-checks every statement through
the SQL guard.

That split is deliberate — the model and the client can propose anything, and
nothing they propose is trusted until the save re-derives it — but it used to
mean an editing session had exactly one outcome and no memory. This page
describes what the session holds now.

## Saving

There are two save actions and they differ only in where they leave you:

- **Save version** writes a new version and keeps you in the editor. The version
  number in the header goes up and the "unsaved changes" marker clears.
- **Save & view** does the same and then opens the live dashboard.

Both take the optional **version note** next to the buttons: a short line about
what changed, stored on the `dashboard_versions` row. Nothing reads it — it is
not part of the spec, it never reaches the model, and it has no effect on
execution. It is there so a version history reads as a sequence of intentions
rather than a column of timestamps. (The history UI that surfaces it is
[#73](https://github.com/jbouder/holotable/issues/73); until it lands the note
is stored and not yet displayed.)

A failed save leaves you exactly where you were, with the error and every
change still in the editor. Nothing about a failure is recoverable by retrying
from a different place, so the editor does not send you to one.

## Undo and redo

Every change to the spec — adding, deleting or editing a panel, arranging the
grid, applying a template, accepting a natural-language edit, re-pointing panels
off a removed source — is one entry on a bounded history stack
(`src/lib/editor/use-history.ts`). Undo and redo walk it; a new change after an
undo abandons the redo branch.

Typing coalesces. A burst of keystrokes in one field within a second is one
entry, so undoing a renamed panel takes back the rename, not the last letter of
it. Inside a text box the browser's own undo still works: the editor's binding
is suppressed while focus is in a field.

## Unsaved changes

The editor knows whether anything has actually changed by comparing the working
spec with the last one written to the server, so typing a character and deleting
it again is correctly not a change.

While there is a real change:

- Closing or reloading the tab asks the browser's "leave site?" prompt.
- Clicking a link out of the editor — including Cancel — asks first, and offers
  **Save and leave**, **Discard changes**, or **Keep editing**.

## Draft autosave

The working spec is mirrored to `localStorage` a moment after you stop typing,
keyed by dashboard and by the signed-in subject
(`src/lib/editor/drafts.ts`). Reopening the editor offers it back with a summary
of what it would change.

Three rules bound what that can do:

- **Nothing is sent to the server.** A draft is an unvalidated spec that only
  its author has seen. The only thing the system ever writes is an explicit
  saved version, which is re-validated and re-guarded. A server-side draft
  table is an explicitly optional extension in
  [#118](https://github.com/jbouder/holotable/issues/118) and is not built.
- **A draft never silently wins.** It is restored by a click, never on load. If
  the dashboard was saved by someone else while the draft sat in your browser,
  the editor says so and explains that restoring writes your changes as a new
  version on top of theirs rather than replacing them.
- **Storage is bounded.** Drafts are per user, capped in size, expire after a
  week, and expired ones from every dashboard are pruned whenever the editor
  opens. A draft is cleared on a successful save or an explicit discard.

## Keyboard shortcuts

Press `?` in the editor for the list. Every binding is an accelerator for a
button that is still there — nothing is reachable by keyboard only. The modifier
follows the platform (`⌘` on macOS, `Ctrl` elsewhere), and bare-letter bindings
do not fire while you are typing in a field.

| Binding | Does |
| --- | --- |
| `⌘S` / `Ctrl+S` | Save a version and keep editing |
| `⌘⇧S` / `Ctrl+Shift+S` | Save and view the dashboard |
| `⌘Z` / `Ctrl+Z` | Undo |
| `⌘⇧Z` / `Ctrl+Shift+Z` | Redo |
| `⌘Enter` / `Ctrl+Enter` | Apply the natural-language edit; run the preview in the SQL box |
| `N` | Add a panel |
| `/` | Focus the natural-language prompt |
| `Esc` | Dismiss the generated panel under review |
| `?` | Show the shortcut list |
