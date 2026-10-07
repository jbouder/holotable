---
title: Editing a dashboard
description: What an editing session holds, when it is written, and what happens to work that is never saved.
sidebar:
  order: 6
---

The editor (`src/app/dashboards/[id]/edit/`) is where a dashboard spec is
edited; the only other writers are a rename and a restore from the history. Everything it does happens in the browser until you press Save; a save
is the one moment a new `dashboard_versions` row is written, and it is the only
moment the server re-validates the spec and re-checks every statement through
the SQL guard.

That split is deliberate — the model and the client can propose anything, and
nothing they propose is trusted until the save re-derives it — but it used to
mean an editing session had exactly one outcome and no memory. This page
describes what the session holds now.

## The canvas and the inspector

The editor is the dashboard itself. The **canvas** draws every panel with its
live preview — each panel's guarded query run once through `/api/query`, and run
again only when that panel's SQL, window or the variable values change, after a
short pause in typing (`src/lib/preview-runs.ts`). Moving, resizing or restyling
a panel reuses the rows it already has, and the chart is never recreated: the
grid moves the panel's card.

Click a panel (or focus it and press Enter) to select it. The **inspector**
beside the canvas then edits that panel, top to bottom:

- **Ask AI**: the natural-language edit, which runs the model once and shows
  the change as a diff to accept, reject or regenerate.
- **Data**: the source, the SQL with its guarded preview, the time field, and
  the panel's own window and refresh. A text panel shows its Markdown here.
- **Visualization**: title, kind, value format and description.
- **Display**: the presentation options, collapsed until wanted.

The panel's actions menu holds **Duplicate**, **Save as template** and
**Delete**. Closing the panel (or selecting nothing) shows the dashboard's own
settings instead: the time range (the same picker readers use), the refresh
interval as presets with a custom value in seconds, the `Arrange: N-up`
presets, **Variables**, **Annotations**, and the description and tags. The
title is edited in place at the top of the page. On a narrow screen the
inspector sits under the canvas.

## Saving

There is one **Save**. It opens a small form with the optional version note and
two ways to finish, which differ only in where they leave you:

- **Save version** writes a new version and keeps you in the editor. The version
  number in the header goes up and the "unsaved changes" marker clears.
- **Save and view** does the same and then opens the live dashboard.

The keyboard shortcuts save directly, without the form. The **version note** is
a short line about
what changed, stored on the `dashboard_versions` row. Nothing reads it — it is
not part of the spec, it never reaches the model, and it has no effect on
execution. It is there so a version history reads as a sequence of intentions
rather than a column of timestamps, and the history page shows it beside each
version.

A failed save leaves you exactly where you were, with the error and every
change still in the editor. Nothing about a failure is recoverable by retrying
from a different place, so the editor does not send you to one.

## Version history and restore

**Version history** in the dashboard's **More actions** menu opens
`/dashboards/[id]/versions`: every saved version with its author, time and note.
Pick one to see what changed between it and the current version, panel by panel
with SQL as a line diff, or to preview it. The preview runs each panel's query
once through the same guarded `/api/query` as the editor's preview and saves
nothing. Viewers can read the history too, since every version in it is a spec
they could have seen when it was current.

An editor can **restore** a version. Restore does not edit anything or move the
dashboard back to an old row. It saves a new version that copies the old spec,
noted `restored from vN`, so the restore shows up in the history like any other
save and can itself be undone the same way. The copy is re-checked like a save:
if a source, table or column the old version reads has since been removed or
hidden, the restore is refused and the current version stays.

## Details, which are not the spec

**Description and tags** in the dashboard settings (also in the editor's
overflow menu, and the **Details…** action on a card in the dashboard list) edits the dashboard's *description* and *tags*.
Those are columns on the `dashboards` row, not fields in the spec: they do not
make the editor dirty, they are not undoable, they are saved the moment the
dialog is confirmed, and they do not append a version.

The **name** is the opposite case and is edited in the page header with the
rest of the spec. Renaming from the dashboard list does the same thing the long
way round — it appends a version whose spec differs only in the title — because
[the spec owns the title](/architecture/data-model/).

## Arranging panels

Order, position and size live in one place: the canvas. Drag a panel to move
it and drag its corner to resize it; with a panel focused, the arrow keys move
it, Shift and the arrow keys resize it, and Delete removes it. Each gesture is
one change to the spec, committed when the pointer comes up. There is no
separate list to keep in step with the grid, and width is not a form field.

The `Arrange: N-up` presets in the dashboard settings re-flow every panel into
N columns in reading order, as one undoable step. **Duplicate** copies a panel
with a fresh id, `" (copy)"` on the title, and the row directly below the
original; anything already there is pushed down rather than covered. The copy
is selected, because the point of duplicating is to then change it.

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

**Add panel** offers three starts: a **blank panel** (that starter), **describe
it to the model**, or **from a template**. Describing adds the same starter and
puts the cursor in the natural-language box, so the first thing you do with the panel is say what it
should be. That runs the model once and lands as a reviewable diff, exactly like
any other natural-language edit.

## Panel description

The inspector's **Visualization** section has a **Description** field: one sentence saying what the panel
computes. The model writes one for every panel it generates, and this is where a
human corrects it. It is shown to readers behind the info control on the panel
header, never as a paragraph on the dashboard itself.

## Undo and redo

Every change to the spec — adding, duplicating, moving, resizing, deleting or
editing a panel, arranging the grid, applying a template, accepting a natural-language
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
- Clicking a link out of the editor — including Close — asks first, and offers
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
