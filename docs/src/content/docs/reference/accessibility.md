---
title: Accessibility statement
description: The WCAG 2.2 AA target, how far Holotable meets it, what checks it and where, every drag's other way, and the known exceptions.
sidebar:
  order: 5
---

Holotable aims to conform to **WCAG 2.2 Level AA**, in every shipped theme and
both color schemes, from phone width up. It **partially conforms**: what is
checked, how, and the known exceptions are below. A new exception gets an
issue and a line here.

This covers the app: every page a signed-in person uses, the signed-out card
and share-link embeds. It does not cover the sign-in page itself, which is
the identity provider's (see [Known exceptions](#known-exceptions)), or this
documentation site. How the interface is built to the bar, and the measured
contrast of every token pairing, is on [Accessibility](/architecture/accessibility/).

## How it is checked

Automated. `npm test` runs in CI's required `Test` job on every pull request.
`npm run e2e` runs in the `End-to-end and accessibility` job on every pull
request that changes code and on `main`, and that job is required to merge
too.

| What | Where |
| --- | --- |
| axe-core (the WCAG 2.0, 2.1 and 2.2 A and AA rules, and best practice) on every main surface: the dashboard list, a live dashboard and the demo dashboards, the editor and its PromQL, LogQL and link forms, Explore (empty, with an answer, filtered, and at 390 px with its side panel open), data sources with the DuckDB, upload and Loki forms, Models, Settings, the dashboard chat, and an open dialog, menu and popover; in the default theme's dark and light. Every violation fails, whatever its impact. A chart's canvas is excluded; its name and table are scanned. An open menu or listbox popup counts as a landmark region, as a dialog does, since it is portaled outside the page's landmarks and reached from its trigger | `e2e/a11y.spec.ts`, `e2e/support/a11y.ts` |
| The same scan of the live dashboard in every other shipped theme, both schemes; of the signed-out card; of a share-link embed and the share dialog | `e2e/a11y.spec.ts` |
| Contrast of every text/background token pairing ≥ 4.5:1, and of chart series and fills ≥ 3:1, in every theme and both schemes, measured from the tokens as the browser paints them; the table on [Accessibility](/architecture/accessibility/#contrast) is what the tokens produce | `test/contrast.test.ts`, `src/lib/color/contrast.ts` |
| Every theme clears the quality bar: borders, the focus ring, selection, code colors, and statuses and chart series still distinct under protanopia, deuteranopia and tritanopia. The High contrast theme holds text at 7:1 and borders at 4.5:1 | `test/theme-quality.test.ts`, `src/lib/color/quality.ts` |
| No color literal outside the token files, so nothing escapes the checks above | `test/color-literals.test.ts` |
| A chart's text alternative: its name says its title and kind and never a value; its table carries every column, times on the reader's clock, values in the panel's format, the newest rows, and says how many it left out | `test/chart-accessibility.test.ts` |
| Focus: a dialog traps it and gives it back to its opener; the share dialog keeps it while it creates a link; the account menu returns it on Escape; every Tab stop, from the top of the page round to the start again, draws a visible indicator and is not hidden behind anything (2.4.7, 2.4.11) on the dashboard list, a new dashboard, data sources, Explore, Models, Settings, a live dashboard, the editor and a dashboard of graphs with zoom and pan controls, and inside an open dialog, menu (by its arrow keys) and popover | `e2e/keyboard.spec.ts` |
| The skip link is the first Tab stop and lands on `<main>` | `e2e/keyboard.spec.ts` |
| A directed and a force graph zoom, pan and reset from the keyboard; the controls show only on a graph that roams (not a tree, not a directed graph drawn as boxes, which fits whole) | `e2e/keyboard.spec.ts`, `test/graph.test.ts` |
| The theme gallery is a radio group: Tab reaches the chosen card, the arrow keys move and choose | `e2e/keyboard.spec.ts` |
| A menu taller than the window scrolls inside itself, and the keyboard brings its last item into view | `e2e/a11y.spec.ts` |
| The editor's canvas from the keyboard: the arrow keys move a panel, Shift and the arrow keys resize it, Delete and Backspace remove it; the live panel under the handle is `inert` | `test/panel-layout-grid.test.tsx` |
| The editor's shortcuts: a bare-letter binding never fires while typing in a field, and undo inside a field is the field's own | `test/editor-shortcuts.test.ts` |
| No sideways scroll (1.4.10): every main page at 320 CSS px (the dashboard list, a new dashboard, data sources, Explore, Models, Settings, the demo and fleet dashboards, the editor), and the demo dashboard at 1440 px. A chart or a wide table scrolls inside its own box; the page never does | `e2e/flows.spec.ts` |
| A phone: the axe scans and the flows run again on an emulated Pixel 7 (touch, a 412 px viewport, a coarse pointer, so touch targets are their 44 px size), including Explore's side panel as a sheet | `e2e/playwright.config.ts` (`phone`), `e2e/a11y.spec.ts`, `e2e/flows.spec.ts` |
| Reduced motion: one switch (`<html data-motion>`) that follows the system unless Settings says otherwise; nothing keys off the media query directly; no animation library | `test/motion.test.ts`, `test/motion-rules.test.ts`, `src/app/globals.css` |
| Forced colors (Windows Contrast themes): a chart opts out and is drawn in system colors, a tint keeps an edge, focus is a 2px ring in `Highlight` even on a filled button | `e2e/a11y.spec.ts`, `src/app/globals.css` |

Manual, before each release (record the date and anything found):

| Check | Last done | Notes |
| --- | --- | --- |
| VoiceOver on macOS (Safari): open a dashboard, read a chart's table, follow a datum link, open a panel fullscreen and close it; ask Explore a question; the command palette | _not yet recorded_ | |
| NVDA on Windows (Firefox or Chrome): the same | _not yet recorded_ | |
| Keyboard only, no mouse: create a dashboard, arrange and edit panels in the editor, save, add a data source | _not yet recorded_ | The specs above cover focus and the canvas keys. |
| 200% and 400% browser zoom on desktop | _not yet recorded_ | 320 CSS px and a phone are automated; zoom also scales text and the editor's canvas, which they do not. |
| Forced colors on Windows (Contrast themes) | _not yet recorded_ | The outlines and focus color are automated; the look is not. |

## Every drag has another way

WCAG 2.1.1 (keyboard) and 2.5.7 (dragging movements).

| Drag (mouse) | Keyboard | Without a drag |
| --- | --- | --- |
| Editor: move a panel on the canvas | Focus its tile, then the arrow keys | None for one panel (#681); **Arrange: N-up** in the dashboard settings re-flows them all. See [Known exceptions](#known-exceptions) |
| Editor: resize a panel by its corner | Shift and the arrow keys on its tile, or the arrow keys on the corner handle | None (#681). See [Known exceptions](#known-exceptions) |
| Brush across a line, area or bar chart to set the window | The time picker: quick ranges, Last N, or an absolute start and end | The same picker |
| Pan and zoom a directed or force graph | Tab to its zoom and pan controls, then `+`, `-`, `0` (reset) and the arrow keys | The controls in the chart's corner: zoom in, zoom out, reset view, and an arrow each way |
| Drop files on the DuckDB upload picker | **Choose files…** | **Choose files…** |

## Known exceptions

- **Moving and resizing a panel without a keyboard needs a drag** (2.5.7).
  The arrow keys do both; a pointer has no single-tap way to place or size one
  panel (#681).
- **A chart's table lists the newest rows**, not all of them, and says how
  many it left out. **Export CSV** in the panel's menu saves every row the
  panel is showing.
- **Explore's answers are written by a language model.** Their prose is
  rendered as Markdown and not reviewed for reading level or structure.
- **Signing in happens on the identity provider's page.** The bundled realm
  uses Keycloak's stock `keycloak` login theme, which Holotable does not draw
  or scan.
- **The manual checks above have not been recorded yet.** Until they are,
  this statement rests on the automated checks.

## Building it in

- Colors are tokens (`src/app/globals.css`); a new text pairing goes in
  `CONTRAST_PAIRS`, a new token in `THEME_FILE_TOKENS`, and the contrast
  table on [Accessibility](/architecture/accessibility/#contrast) is pasted
  from `contrastTable()` until `test/contrast.test.ts` passes.
- A new page, dialog or menu adds itself to the default theme's scans in
  `e2e/a11y.spec.ts`; an axe exclusion is named in `e2e/support/a11y.ts` with
  its reason, and nowhere else.
- A chart goes through `AccessibleChart`; a link styled as a button is
  `ButtonLink`; an icon-only control has an `aria-label`, and a control's
  `aria-label` holds the text it shows (2.5.3).
- A button whose work is running passes `busy`, not `disabled`, so it keeps
  focus.
- A new drag needs a keyboard way and a way without a drag, and a row in the
  table above.
- Motion follows [Motion](/architecture/motion/); state carried by a fill
  gets an edge under forced colors.

Found something? Open an issue with the `area:a11y` label.

---

*Last verified against the code at commit `f631480` (2026-10-27).*
