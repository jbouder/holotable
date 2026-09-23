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

## Details, which are not the spec

The **details** button in the editor header (and the **Details…** action on a
card in the dashboard list) edits the dashboard's *description* and *tags*.
Those are columns on the `dashboards` row, not fields in the spec: they do not
make the editor dirty, they are not undoable, they are saved the moment the
dialog is confirmed, and they do not append a version.

The **name** is the opposite case and is edited in the settings card with the
rest of the spec. Renaming from the dashboard list does the same thing the long
way round — it appends a version whose spec differs only in the title — because
[the spec owns the title](/architecture/data-model/).

## The panel list

The list on the left is the dashboard's panel *order*, which is what the
`Arrange: N-up` presets flow onto the grid. Each row has an overflow menu with
the actions that change it:

- **Duplicate** copies the panel with a fresh id, `" (copy)"` on the title, and
  the row directly below the original; anything already there is pushed down
  rather than covered. The copy is selected, because the point of duplicating is
  to then change it.
- **Move up / down / to top / to bottom** move the panel through the order.
  Dragging a row's handle does the same thing.

Reordering touches the order and nothing else. A panel's position on the grid
lives in its `layout`, so a dashboard you have arranged by hand survives a
reorder unchanged — the new order reaches the grid only when you apply an
`Arrange` preset. That is also why the actions are on the list and the dragging
is on the grid: the two are different questions.

Deleting is undoable, so it asks first only when there is work to lose — when
the panel's SQL is no longer the starter the editor wrote for it.

## New panels

A new panel starts from a query built out of the selected source's own catalog
(`src/lib/panel-starter.ts`): the first allowlisted table with a time column,
counted per minute, as a line chart. A source whose tables have no time column
gets a plain `count(*)` as a stat instead, and a source with no usable table at
all falls back to `SELECT 1 AS value`.

Because every name in it comes from the source's allowlist, the starter is
guaranteed to pass the SQL guard against that source — and it never filters time
itself, because the server owns the range.

**Describe** adds the same starter and puts the cursor in the
natural-language box, so the first thing you do with the panel is say what it
should be. That runs the model once and lands as a reviewable diff, exactly like
any other natural-language edit.

## Panel description

The panel editor has a **Description** field: one sentence saying what the panel
computes. The model writes one for every panel it generates, and this is where a
human corrects it. It is shown to readers behind the info control on the panel
header, never as a paragraph on the dashboard itself.

## Undo and redo

Every change to the spec — adding, duplicating, reordering, deleting or editing
a panel, arranging the grid, applying a template, accepting a natural-language
edit, re-pointing panels off a removed source — is one entry on a bounded
history stack
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
| `D` | Duplicate the selected panel |
| `/` | Focus the natural-language prompt |
| `Esc` | Dismiss the generated panel under review |
| `?` | Show the shortcut list |
