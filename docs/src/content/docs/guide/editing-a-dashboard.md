---
title: Editing a dashboard
description: The canvas and the inspector, saving, version history, what happens to work that is never saved, and the keyboard shortcuts.
---

Everything you do in the editor happens in your browser until you press
**Save**. A save writes a new version of the dashboard, and it is the moment
the server checks the whole spec again and every query in it; until then
nothing you have typed has reached the server. This page is what an editing
session holds and what happens to work that is never saved.

## The canvas and the inspector

The editor is the dashboard itself. The **canvas** draws every panel with a
live preview, run when the panel appears and again when its query, window or
variable values change, after a short pause in typing. Moving, resizing or
restyling a panel keeps the rows it already has.

Click a panel (or focus it and press Enter) to select it. The **inspector**
beside the canvas then edits that panel, top to bottom:

- **Ask AI**: the natural-language edit, which runs the model once and shows
  the change as a diff to accept, reject or regenerate.
- **Data**: the source, the query with its preview, and the panel's own window
  and refresh. For a SQL source that is the SQL and its time field; for a
  Prometheus source it is the PromQL, **Instant** and **Min step** (see
  [Writing the query](/concepts/executing-a-panel/#a-promql-panel)). Choosing a
  source of the other kind restarts the query from that source's starter
  rather than keeping one its source cannot run. A text panel shows its
  Markdown here.
- **Visualization**: title, kind, value format and description.
- **Display**: the presentation options, collapsed until wanted. A custom
  visual's whole spec is edited here, as JSON: a problem the checks find
  (data other than the panel's rows, a literal color, an unknown mark) is
  named under the field as you type, and so is the compiler's message when
  the spec does not compile. See [Custom visuals](/architecture/custom-visuals/).
- **Links**: where the panel leads (see [Links](#links) below). Not on a text
  panel.

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
a short line about what changed, stored with the version. Nothing reads it — it
is not part of the spec, it never reaches the model, and it has no effect on
execution. It is there so a version history reads as a sequence of intentions
rather than a column of timestamps, and the history page shows it beside each
version.

A failed save leaves you exactly where you were, with the error and every
change still in the editor.

## Links

The **Links** section edits the panel's [drilldown](/guide/drilldown/)
links without JSON. Each link is a row with its title and target, which can be
edited, moved up or down, or removed. **Add link** opens a form:

- **Leads to**: this dashboard, or another one in the workspace, found by
  title.
- **Title**: what the menu item or the click says. It follows the target's
  title until it is changed.
- **Carry the time range** and **Carry the variable picks**, on by default,
  and **Open in a new tab** for a link to another dashboard.
- **Set on arrival**: one row per pick. The variable is chosen from the ones
  the target declares (this dashboard's own for a self link). Its value is a
  literal, a column of the clicked row (the columns this panel's last preview
  returned), or the clicked series. A pick the target does not declare is
  flagged, since the target would ignore it.

A link that stays on this dashboard must set at least one of its variables;
the form refuses it otherwise. **Links (JSON)** edits the whole list as JSON
for anything the form does not cover. Link changes show in the edit review and
in version history, one row per link title.

## Version history and restore

**Version history** in the dashboard's **More actions** menu lists every saved
version with its author, time and note. Pick one to see what changed between
it and the current version, panel by panel with the query as a line diff, or
to preview it. The preview runs each panel's query once and saves nothing.
Viewers can read the history too, since every version in it is a dashboard
they could have seen when it was current.

An editor can **restore** a version. Restore does not edit anything or move the
dashboard back to an old version. It saves a new version that copies the old
one, noted `restored from vN`, so the restore shows up in the history like any
other save and can itself be undone the same way. The copy is checked like a
save: if a source, table or column the old version reads has since been
removed or hidden, the restore is refused and the current version stays.

## Details, which are not the spec

**Description and tags** in the dashboard settings (also in the editor's
overflow menu, and the **Details…** action on a card in the dashboard list)
edits the dashboard's *description* and *tags*. Those are kept beside the
dashboard rather than in it: they do not make the editor dirty, they are not
undoable, they are saved the moment the dialog is confirmed, and they do not
add a version.

The **name** is the opposite case and is edited in the page header with the
rest of the dashboard. Renaming from the dashboard list does the same thing the
long way round — it adds a version that differs only in the title — because
[the spec owns the title](/architecture/data-model/).

## Arranging panels

Order, position and size live in one place: the canvas. Drag a panel to move
it and drag its corner to resize it; with a panel focused, the arrow keys move
it, Shift and the arrow keys resize it, and Delete removes it. Each gesture is
one change, committed when the pointer comes up.

The `Arrange: N-up` presets in the dashboard settings re-flow every panel into
N columns in reading order, as one undoable step. **Duplicate** copies a panel
with a fresh id, `" (copy)"` on the title, and the row directly below the
original; anything already there is pushed down rather than covered. The copy
is selected, because the point of duplicating is to then change it.

Deleting is undoable, so it asks first only when there is work to lose — when
the panel's query is no longer the starter the editor wrote for it.

## New panels

**Add panel** offers three starts: a **blank panel**, **describe it to the
model**, or **from a template**.

A blank panel starts from a query built out of the selected source's own
catalog, so it always runs: on a SQL source, the first table with a time
column, counted per minute, as a line chart (a plain count as a stat when no
table has a time column); on a Prometheus source, a rate over its first
counter, else a histogram's p95, else a gauge's sum. The template picker's
built-ins for a Prometheus source are golden signals built the same way from
its catalog.

Describing adds the same starter and puts the cursor in the natural-language
box, so the first thing you do with the panel is say what it should be. That
runs the model once and lands as a reviewable diff, exactly like any other
natural-language edit.

## Panel description

The inspector's **Visualization** section has a **Description** field: one
sentence saying what the panel computes. The model writes one for every panel
it generates, and this is where a human corrects it. It is shown to readers
behind the info control on the panel header, never as a paragraph on the
dashboard itself.

## Undo and redo

Every change — adding, duplicating, moving, resizing, deleting or editing a
panel, arranging the grid, applying a template, accepting a natural-language
edit, re-pointing panels off a removed source — is one step. Undo and redo walk
them; a new change after an undo abandons the redo branch.

Typing coalesces. A burst of keystrokes in one field within a second is one
step, so undoing a renamed panel takes back the rename, not the last letter of
it. Inside a text box the browser's own undo still works.

## Unsaved changes

The editor knows whether anything has actually changed by comparing what you
have with what was last saved, so typing a character and deleting it again is
correctly not a change.

While there is a real change:

- Closing or reloading the tab asks the browser's "leave site?" prompt.
- Clicking a link out of the editor — including Close — asks first, and offers
  **Save and leave**, **Discard changes**, or **Keep editing**.

## Draft autosave

A moment after you stop typing, the editor keeps a draft of your work in this
browser, for this dashboard and this account. Reopening the editor offers it
back with a summary of what it would change.

Three things to know about a draft:

- **It is only in your browser.** Nothing is sent to the server until you
  save, and a draft is not visible to anyone else or from another device.
- **It never silently wins.** It is restored by a click, never on load. If the
  dashboard was saved by someone else while the draft sat in your browser, the
  editor says so: restoring writes your changes as a new version on top of
  theirs rather than replacing them.
- **It does not last forever.** A draft expires after a week, and is cleared
  on a successful save or an explicit discard.

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
