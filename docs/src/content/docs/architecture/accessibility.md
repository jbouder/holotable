---
title: Accessibility
description: The WCAG 2.1 AA bar, what holds the interface to it, the measured contrast of every token pairing, and the automated checks in CI.
sidebar:
  order: 6
---

Holotable aims at WCAG 2.1 AA. Most of it is ordinary markup done carefully;
this page records the parts that are deliberate decisions, and the checks that
keep them from regressing (#77, #91).

## Keyboard

- **Skip link.** The first Tab on any page is *Skip to content*, which moves
  focus to `<main id="main">`.
- **Dialogs** trap focus and give it back to what opened them on close (Base
  UI). A panel's fullscreen view is a dialog too: Escape closes it and focus
  returns to the control that opened it.
- **Editor.** On the canvas, each panel is a button named by its title and
  position: Enter selects it (`aria-pressed`), the arrow keys move it, Shift and
  the arrow keys resize it, and Delete or Backspace removes it. The live panel
  under it is `inert`, so Tab reaches the handle and not the chart's own
  controls. Duplicate, Save as template and Delete are also in the inspector's
  named panel menu, and every deletion is one step to undo. The keys are listed
  under *Settings → Shortcuts*.
- **Command palette.** The listbox follows the APG combobox pattern rather
  than a menu — real focus stays in the text field and `aria-activedescendant`
  points at the selection — because a menu would move focus out of the box
  being typed into.
- **Focus is always visible.** Every interactive primitive draws
  `focus-visible:outline-2 outline-primary`. A scroll container that can
  overflow (a table panel, an Explore result) is itself focusable, so it can be
  scrolled from the keyboard.
- **Links are links.** Something that navigates is one `<a>` styled as a
  button (`ButtonLink`), never a `<button>` inside a link: that was two tab
  stops for one action.

## Charts

A canvas has nothing for a screen reader to read, so every chart panel
(`AccessibleChart`) carries:

- an accessible name on the chart (`role="img"`): its title and kind, never a
  value;
- a visually hidden table of the rows the chart draws, newest 50, with times on
  the reader's clock and values in the panel's format;
- ECharts' `aria` decals, so bar, pie and area series are told apart by pattern
  as well as by color.

Each panel is a named region, so a screen reader's landmark list doubles as
the dashboard's table of contents.

## Motion

Every animation is gated by the motion preference; see [Motion](/architecture/motion/).
Spinners freezing to a single frame under *Reduce* is intended.

## Contrast

Every text-on-background pairing the interface uses meets AA (4.5:1) in both
themes. The pairings are listed in `src/lib/color/contrast.ts`, measured from
the OKLCH tokens in `src/app/globals.css` (resolved to sRGB, translucent tints
composited over the surface the way the browser paints them), and
`test/contrast.test.ts` fails if any drops below 4.5:1 — or if this table is
not what the tokens produce.

In the dark theme the primary button carries dark text: a blue light enough to
read as text on `surface-2` is too light to carry white at AA.

| Pairing | Dark | Light |
| --- | --- | --- |
| text-foreground on bg-background | 17.31:1 | 17.05:1 |
| text-foreground on bg-surface | 15.80:1 | 18.10:1 |
| text-foreground on bg-surface-2 | 13.85:1 | 15.17:1 |
| text-muted on bg-background | 7.29:1 | 5.67:1 |
| text-muted on bg-surface | 6.66:1 | 6.02:1 |
| text-muted on bg-surface-2 | 5.84:1 | 5.04:1 |
| text-primary on bg-background | 6.06:1 | 5.38:1 |
| text-primary on bg-surface | 5.53:1 | 5.71:1 |
| text-primary on bg-surface-2 | 4.85:1 | 4.78:1 |
| text-danger on bg-background | 7.25:1 | 6.71:1 |
| text-danger on bg-surface | 6.63:1 | 7.12:1 |
| text-danger on bg-surface-2 | 5.81:1 | 5.97:1 |
| text-warning on bg-background | 9.48:1 | 5.78:1 |
| text-warning on bg-surface | 8.65:1 | 6.13:1 |
| text-warning on bg-surface-2 | 7.59:1 | 5.14:1 |
| text-success on bg-background | 7.85:1 | 6.01:1 |
| text-success on bg-surface | 7.16:1 | 6.38:1 |
| text-success on bg-surface-2 | 6.28:1 | 5.34:1 |
| text-foreground on hover:bg-surface-3 | 11.77:1 | 13.44:1 |
| text-danger on bg-danger/5 (badges, alerts) | 6.25:1 | 6.48:1 |
| text-danger on bg-danger/10 (badges, alerts) | 5.77:1 | 5.92:1 |
| text-danger on bg-danger/15 (badges, alerts) | 5.34:1 | 5.37:1 |
| text-danger on bg-danger/20 (badges, alerts) | 4.85:1 | 4.85:1 |
| text-warning on bg-warning/5 (badges, alerts) | 8.02:1 | 5.69:1 |
| text-warning on bg-warning/10 (badges, alerts) | 7.33:1 | 5.32:1 |
| text-warning on bg-warning/15 (badges, alerts) | 6.61:1 | 4.92:1 |
| text-warning on bg-warning/20 (badges, alerts) | 5.92:1 | 4.58:1 |
| text-success on bg-success/5 (badges, alerts) | 6.72:1 | 5.93:1 |
| text-success on bg-success/10 (badges, alerts) | 6.22:1 | 5.51:1 |
| text-success on bg-success/15 (badges, alerts) | 5.64:1 | 5.07:1 |
| text-success on bg-success/20 (badges, alerts) | 5.12:1 | 4.69:1 |
| text-primary on bg-primary/10 | 4.85:1 | 4.92:1 |
| text-foreground on a success status tile | 9.91:1 | 12.91:1 |
| text-foreground on a warning status tile | 9.33:1 | 13.49:1 |
| text-foreground on a danger status tile | 11.26:1 | 11.83:1 |
| text-foreground on a info status tile | 10.67:1 | 12.29:1 |
| text-foreground on a neutral status tile | 9.74:1 | 13.17:1 |
| text-foreground on a orange status tile | 10.20:1 | 12.84:1 |
| text-foreground on a purple status tile | 11.06:1 | 12.04:1 |
| text-foreground on a teal status tile | 9.60:1 | 13.04:1 |
| primary button | 6.06:1 | 5.37:1 |
| danger button | 7.25:1 | 6.70:1 |

## Automated checks

- `npm test`: the contrast table above, the chart table and description
  (`test/chart-accessibility.test.ts`), and the editor's Delete keys.
- `npm run e2e`: axe-core over every main surface, an open dialog, an open
  menu and the chat panel, in both themes (`e2e/a11y.spec.ts`). Serious and
  critical violations fail; moderate and minor are reported on the test.
  Exclusions are named in `e2e/support/a11y.ts` with the reason. What axe
  cannot see is asserted as behavior in `e2e/keyboard.spec.ts`: the focus
  trap and its return, the skip link, a visible focus indicator on every Tab
  stop, and the editor keys.

A manual pass with a screen reader is still the maintainer's, per release.

---

*Last verified against the code at commit `4e4c5cf` (2026-10-05).*
