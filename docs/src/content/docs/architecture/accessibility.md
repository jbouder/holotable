---
title: Accessibility
description: How the interface is built to the WCAG 2.2 AA target, and the measured contrast of every token pairing.
sidebar:
  order: 6
---

Holotable aims at WCAG 2.2 AA. Most of it is ordinary markup done carefully;
this page records the parts that are deliberate decisions (#77, #91). How far
it conforms, what checks it, and the known exceptions are the
[Accessibility statement](/reference/accessibility/).

## Keyboard

- **Skip link.** The first Tab on any page is *Skip to content*, which moves
  focus to `<main id="main">`.
- **Dialogs** trap focus and give it back to what opened them on close (Base
  UI). A panel's fullscreen view is a dialog too: Escape closes it and focus
  returns to the control that opened it.
- **Editor.** On the canvas, each panel is a button named by its title and
  position: Enter selects it (`aria-pressed`), the arrow keys move it, Shift and
  the arrow keys resize it, and Delete or Backspace removes it; the inspector's
  **Position and size** buttons do the same moves and resizes with clicks alone
  (2.5.7), and its status line announces where the panel is. The live panel
  under it is `inert`, so Tab reaches the handle and not the chart's own
  controls. Duplicate, Save as template and Delete are also in the inspector's
  named panel menu, and every deletion is one step to undo. The keys are listed
  under *Settings → Shortcuts*.
- **Command palette.** The listbox follows the APG combobox pattern rather
  than a menu — real focus stays in the text field and `aria-activedescendant`
  points at the selection — because a menu would move focus out of the box
  being typed into.
- **Focus is always visible.** Every interactive primitive draws
  `focus-visible:outline-2 focus-visible:outline-ring`. A scroll container that can
  overflow (a table panel, an Explore answer's table) is itself focusable, so it can be
  scrolled from the keyboard.
- **Links are links.** Something that navigates is one `<a>` styled as a
  button (`ButtonLink`), never a `<button>` inside a link: that was two tab
  stops for one action.
- **A control's name holds what it shows.** A trigger with an `aria-label`
  that adds context, such as the model, source and time range chips, the
  account menu and a status tile's link, starts from or contains its visible
  text, word for word and in order, so a voice-control user can say what they
  see (WCAG 2.5.3, Label in Name). axe checks it by joining the text nodes
  inside the control, so sibling spans keep a space between them, and the
  account menu's initials are drawn by CSS, like an avatar picture.

## Charts

A canvas has nothing for a screen reader to read, so every chart panel
(`AccessibleChart`) carries:

- an accessible name on the chart (`role="img"`): its title and kind, never a
  value;
- a visually hidden table of the rows the chart draws, newest 50, with times on
  the reader's clock and values in the panel's format;
- ECharts' `aria` decals, so bar, pie and area series can be told apart by
  pattern as well as by color. They are a preference, **Patterns in charts**
  under Settings → Appearance, off by default and saved to the account; a
  chart picks up a change without being rebuilt.

Each panel is a named region, so a screen reader's landmark list doubles as
the dashboard's table of contents.

## Motion

Every animation is gated by the motion preference; see [Motion](/architecture/motion/).
Spinners freezing to a single frame under *Reduce* is intended.

## Contrast

Contrast is the floor. The wider [theme quality bar](/architecture/theming/#quality-bar)
also covers borders, the focus ring, selection, code colors, and whether
statuses and chart series stay distinct under a color-vision deficiency.

Every text-on-background pairing the interface uses meets AA (4.5:1) in every
theme, in both color schemes. The pairings are listed in `src/lib/color/contrast.ts`, measured from
the OKLCH tokens in `src/app/globals.css` (resolved to sRGB, translucent tints
composited over the surface the way the browser paints them), and
`test/contrast.test.ts` fails if any text pairing drops below 4.5:1, or a
series or fill below 3:1 — or if this table is not what the tokens produce.

In the dark scheme the primary button carries dark text: a blue light enough to
read as text on `surface-2` is too light to carry white at AA.

### holotable

| Pairing | Dark | Light |
| --- | --- | --- |
| text-foreground on bg-background | 17.06:1 | 16.11:1 |
| text-foreground on bg-surface | 15.84:1 | 17.30:1 |
| text-foreground on bg-surface-2 | 14.30:1 | 15.16:1 |
| text-muted on bg-background | 7.95:1 | 5.56:1 |
| text-muted on bg-surface | 7.38:1 | 5.97:1 |
| text-muted on bg-surface-2 | 6.66:1 | 5.23:1 |
| text-primary on bg-background | 8.02:1 | 5.68:1 |
| text-primary on bg-surface | 7.44:1 | 6.10:1 |
| text-primary on bg-surface-2 | 6.71:1 | 5.35:1 |
| text-danger on bg-background | 8.02:1 | 6.63:1 |
| text-danger on bg-surface | 7.45:1 | 7.12:1 |
| text-danger on bg-surface-2 | 6.72:1 | 6.24:1 |
| text-warning on bg-background | 11.15:1 | 5.77:1 |
| text-warning on bg-surface | 10.35:1 | 6.20:1 |
| text-warning on bg-surface-2 | 9.34:1 | 5.43:1 |
| text-success on bg-background | 11.12:1 | 6.85:1 |
| text-success on bg-surface | 10.32:1 | 7.35:1 |
| text-success on bg-surface-2 | 9.32:1 | 6.44:1 |
| text-foreground on hover:bg-surface-3 | 12.17:1 | 13.67:1 |
| text-danger on bg-danger/5 (badges, alerts) | 6.99:1 | 6.48:1 |
| text-danger on bg-danger/10 (badges, alerts) | 6.44:1 | 5.93:1 |
| text-danger on bg-danger/15 (badges, alerts) | 5.90:1 | 5.37:1 |
| text-danger on bg-danger/20 (badges, alerts) | 5.31:1 | 4.85:1 |
| text-warning on bg-warning/5 (badges, alerts) | 9.54:1 | 5.77:1 |
| text-warning on bg-warning/10 (badges, alerts) | 8.56:1 | 5.36:1 |
| text-warning on bg-warning/15 (badges, alerts) | 7.64:1 | 4.96:1 |
| text-warning on bg-warning/20 (badges, alerts) | 6.75:1 | 4.59:1 |
| text-success on bg-success/5 (badges, alerts) | 9.45:1 | 6.79:1 |
| text-success on bg-success/10 (badges, alerts) | 8.56:1 | 6.27:1 |
| text-success on bg-success/15 (badges, alerts) | 7.60:1 | 5.81:1 |
| text-success on bg-success/20 (badges, alerts) | 6.67:1 | 5.33:1 |
| text-primary on bg-primary/10 | 6.38:1 | 5.25:1 |
| text-foreground on a success status tile | 9.06:1 | 11.13:1 |
| text-foreground on a warning status tile | 9.14:1 | 12.50:1 |
| text-foreground on a danger status tile | 10.04:1 | 10.46:1 |
| text-foreground on a info status tile | 9.92:1 | 11.28:1 |
| text-foreground on a neutral status tile | 9.90:1 | 11.64:1 |
| text-foreground on a orange status tile | 9.28:1 | 12.20:1 |
| text-foreground on a purple status tile | 9.57:1 | 11.37:1 |
| text-foreground on a teal status tile | 9.28:1 | 11.14:1 |
| success as text on bg-background | 11.12:1 | 6.85:1 |
| success as text on bg-surface | 10.32:1 | 7.35:1 |
| success as text on bg-surface-2 | 9.32:1 | 6.44:1 |
| warning as text on bg-background | 11.15:1 | 5.77:1 |
| warning as text on bg-surface | 10.35:1 | 6.20:1 |
| warning as text on bg-surface-2 | 9.34:1 | 5.43:1 |
| danger as text on bg-background | 8.02:1 | 6.63:1 |
| danger as text on bg-surface | 7.45:1 | 7.12:1 |
| danger as text on bg-surface-2 | 6.72:1 | 6.24:1 |
| info as text on bg-background | 8.02:1 | 5.68:1 |
| info as text on bg-surface | 7.44:1 | 6.10:1 |
| info as text on bg-surface-2 | 6.71:1 | 5.35:1 |
| neutral as text on bg-background | 7.95:1 | 5.56:1 |
| neutral as text on bg-surface | 7.38:1 | 5.97:1 |
| neutral as text on bg-surface-2 | 6.66:1 | 5.23:1 |
| orange as text on bg-background | 10.43:1 | 5.33:1 |
| orange as text on bg-surface | 9.68:1 | 5.72:1 |
| orange as text on bg-surface-2 | 8.74:1 | 5.01:1 |
| purple as text on bg-background | 9.12:1 | 6.02:1 |
| purple as text on bg-surface | 8.46:1 | 6.46:1 |
| purple as text on bg-surface-2 | 7.64:1 | 5.66:1 |
| teal as text on bg-background | 10.12:1 | 6.89:1 |
| teal as text on bg-surface | 9.40:1 | 7.40:1 |
| teal as text on bg-surface-2 | 8.48:1 | 6.48:1 |
| chart text on bg-background | 7.95:1 | 5.56:1 |
| chart text on bg-surface | 7.38:1 | 5.97:1 |
| chart text on bg-surface-2 | 6.66:1 | 5.23:1 |
| chart series 1 on bg-surface | 6.39:1 | 5.50:1 |
| chart series 2 on bg-surface | 7.81:1 | 4.41:1 |
| chart series 3 on bg-surface | 9.68:1 | 3.75:1 |
| chart series 4 on bg-surface | 6.91:1 | 5.28:1 |
| chart series 5 on bg-surface | 8.46:1 | 6.46:1 |
| chart series 6 on bg-surface | 9.40:1 | 7.40:1 |
| chart series 7 on bg-surface | 6.37:1 | 5.28:1 |
| chart series 8 on bg-surface | 12.41:1 | 8.43:1 |
| warning as a fill on bg-surface | 10.35:1 | 3.17:1 |
| orange as a fill on bg-surface | 9.68:1 | 3.75:1 |
| primary button | 8.02:1 | 5.93:1 |
| danger button | 8.02:1 | 6.93:1 |

### graphite

| Pairing | Dark | Light |
| --- | --- | --- |
| text-foreground on bg-background | 16.51:1 | 16.56:1 |
| text-foreground on bg-surface | 15.29:1 | 17.76:1 |
| text-foreground on bg-surface-2 | 13.69:1 | 15.14:1 |
| text-muted on bg-background | 7.43:1 | 5.73:1 |
| text-muted on bg-surface | 6.88:1 | 6.15:1 |
| text-muted on bg-surface-2 | 6.16:1 | 5.24:1 |
| text-primary on bg-background | 7.33:1 | 6.01:1 |
| text-primary on bg-surface | 6.79:1 | 6.45:1 |
| text-primary on bg-surface-2 | 6.08:1 | 5.50:1 |
| text-danger on bg-background | 7.17:1 | 6.04:1 |
| text-danger on bg-surface | 6.64:1 | 6.48:1 |
| text-danger on bg-surface-2 | 5.95:1 | 5.52:1 |
| text-warning on bg-background | 10.11:1 | 6.94:1 |
| text-warning on bg-surface | 9.36:1 | 7.44:1 |
| text-warning on bg-surface-2 | 8.38:1 | 6.34:1 |
| text-success on bg-background | 10.45:1 | 6.15:1 |
| text-success on bg-surface | 9.68:1 | 6.60:1 |
| text-success on bg-surface-2 | 8.67:1 | 5.62:1 |
| text-foreground on hover:bg-surface-3 | 11.84:1 | 13.43:1 |
| text-danger on bg-danger/5 (badges, alerts) | 6.20:1 | 5.97:1 |
| text-danger on bg-danger/10 (badges, alerts) | 5.78:1 | 5.53:1 |
| text-danger on bg-danger/15 (badges, alerts) | 5.29:1 | 5.07:1 |
| text-danger on bg-danger/20 (badges, alerts) | 4.79:1 | 4.67:1 |
| text-warning on bg-warning/5 (badges, alerts) | 8.57:1 | 6.89:1 |
| text-warning on bg-warning/10 (badges, alerts) | 7.71:1 | 6.38:1 |
| text-warning on bg-warning/15 (badges, alerts) | 6.94:1 | 5.88:1 |
| text-warning on bg-warning/20 (badges, alerts) | 6.12:1 | 5.42:1 |
| text-success on bg-success/5 (badges, alerts) | 8.90:1 | 6.13:1 |
| text-success on bg-success/10 (badges, alerts) | 7.99:1 | 5.66:1 |
| text-success on bg-success/15 (badges, alerts) | 7.15:1 | 5.24:1 |
| text-success on bg-success/20 (badges, alerts) | 6.28:1 | 4.84:1 |
| text-primary on bg-primary/10 | 5.83:1 | 5.55:1 |
| text-foreground on a success status tile | 8.77:1 | 11.26:1 |
| text-foreground on a warning status tile | 8.84:1 | 12.60:1 |
| text-foreground on a danger status tile | 9.80:1 | 11.05:1 |
| text-foreground on a info status tile | 9.70:1 | 11.35:1 |
| text-foreground on a neutral status tile | 9.60:1 | 11.61:1 |
| text-foreground on a orange status tile | 8.91:1 | 12.45:1 |
| text-foreground on a purple status tile | 9.36:1 | 11.24:1 |
| text-foreground on a teal status tile | 9.16:1 | 11.52:1 |
| success as text on bg-background | 10.45:1 | 6.15:1 |
| success as text on bg-surface | 9.68:1 | 6.60:1 |
| success as text on bg-surface-2 | 8.67:1 | 5.62:1 |
| warning as text on bg-background | 10.11:1 | 6.94:1 |
| warning as text on bg-surface | 9.36:1 | 7.44:1 |
| warning as text on bg-surface-2 | 8.38:1 | 6.34:1 |
| danger as text on bg-background | 7.17:1 | 6.04:1 |
| danger as text on bg-surface | 6.64:1 | 6.48:1 |
| danger as text on bg-surface-2 | 5.95:1 | 5.52:1 |
| info as text on bg-background | 7.33:1 | 6.01:1 |
| info as text on bg-surface | 6.79:1 | 6.45:1 |
| info as text on bg-surface-2 | 6.08:1 | 5.50:1 |
| neutral as text on bg-background | 7.43:1 | 5.73:1 |
| neutral as text on bg-surface | 6.88:1 | 6.15:1 |
| neutral as text on bg-surface-2 | 6.16:1 | 5.24:1 |
| orange as text on bg-background | 10.01:1 | 5.65:1 |
| orange as text on bg-surface | 9.27:1 | 6.06:1 |
| orange as text on bg-surface-2 | 8.30:1 | 5.16:1 |
| purple as text on bg-background | 8.19:1 | 6.55:1 |
| purple as text on bg-surface | 7.59:1 | 7.02:1 |
| purple as text on bg-surface-2 | 6.79:1 | 5.98:1 |
| teal as text on bg-background | 9.30:1 | 5.21:1 |
| teal as text on bg-surface | 8.61:1 | 5.59:1 |
| teal as text on bg-surface-2 | 7.71:1 | 4.76:1 |
| chart text on bg-background | 7.43:1 | 5.73:1 |
| chart text on bg-surface | 6.88:1 | 6.15:1 |
| chart text on bg-surface-2 | 6.16:1 | 5.24:1 |
| chart series 1 on bg-surface | 7.59:1 | 7.02:1 |
| chart series 2 on bg-surface | 4.87:1 | 3.86:1 |
| chart series 3 on bg-surface | 8.61:1 | 5.59:1 |
| chart series 4 on bg-surface | 9.27:1 | 3.42:1 |
| chart series 5 on bg-surface | 5.67:1 | 5.48:1 |
| chart series 6 on bg-surface | 8.11:1 | 5.63:1 |
| chart series 7 on bg-surface | 5.20:1 | 5.99:1 |
| chart series 8 on bg-surface | 13.17:1 | 11.62:1 |
| warning as a fill on bg-surface | 9.36:1 | 3.12:1 |
| orange as a fill on bg-surface | 9.27:1 | 3.42:1 |
| primary button | 7.33:1 | 6.17:1 |
| danger button | 7.17:1 | 6.20:1 |

### fjord

| Pairing | Dark | Light |
| --- | --- | --- |
| text-foreground on bg-background | 15.25:1 | 14.70:1 |
| text-foreground on bg-surface | 13.80:1 | 16.11:1 |
| text-foreground on bg-surface-2 | 12.23:1 | 13.63:1 |
| text-muted on bg-background | 7.81:1 | 5.86:1 |
| text-muted on bg-surface | 7.07:1 | 6.42:1 |
| text-muted on bg-surface-2 | 6.26:1 | 5.43:1 |
| text-primary on bg-background | 9.07:1 | 5.70:1 |
| text-primary on bg-surface | 8.21:1 | 6.24:1 |
| text-primary on bg-surface-2 | 7.27:1 | 5.28:1 |
| text-danger on bg-background | 7.04:1 | 5.85:1 |
| text-danger on bg-surface | 6.37:1 | 6.41:1 |
| text-danger on bg-surface-2 | 5.65:1 | 5.43:1 |
| text-warning on bg-background | 12.96:1 | 8.69:1 |
| text-warning on bg-surface | 11.73:1 | 9.52:1 |
| text-warning on bg-surface-2 | 10.39:1 | 8.06:1 |
| text-success on bg-background | 9.86:1 | 6.01:1 |
| text-success on bg-surface | 8.92:1 | 6.59:1 |
| text-success on bg-surface-2 | 7.90:1 | 5.57:1 |
| text-foreground on hover:bg-surface-3 | 10.40:1 | 12.10:1 |
| text-danger on bg-danger/5 (badges, alerts) | 6.01:1 | 5.91:1 |
| text-danger on bg-danger/10 (badges, alerts) | 5.57:1 | 5.45:1 |
| text-danger on bg-danger/15 (badges, alerts) | 5.15:1 | 5.00:1 |
| text-danger on bg-danger/20 (badges, alerts) | 4.67:1 | 4.59:1 |
| text-warning on bg-warning/5 (badges, alerts) | 10.55:1 | 8.75:1 |
| text-warning on bg-warning/10 (badges, alerts) | 9.33:1 | 8.07:1 |
| text-warning on bg-warning/15 (badges, alerts) | 8.17:1 | 7.36:1 |
| text-warning on bg-warning/20 (badges, alerts) | 7.08:1 | 6.70:1 |
| text-success on bg-success/5 (badges, alerts) | 8.12:1 | 6.14:1 |
| text-success on bg-success/10 (badges, alerts) | 7.29:1 | 5.67:1 |
| text-success on bg-success/15 (badges, alerts) | 6.50:1 | 5.27:1 |
| text-success on bg-success/20 (badges, alerts) | 5.82:1 | 4.88:1 |
| text-primary on bg-primary/10 | 6.76:1 | 5.38:1 |
| text-foreground on a success status tile | 7.95:1 | 10.24:1 |
| text-foreground on a warning status tile | 7.33:1 | 11.29:1 |
| text-foreground on a danger status tile | 8.94:1 | 9.90:1 |
| text-foreground on a info status tile | 8.10:1 | 10.25:1 |
| text-foreground on a neutral status tile | 8.43:1 | 10.43:1 |
| text-foreground on a orange status tile | 7.33:1 | 11.19:1 |
| text-foreground on a purple status tile | 8.98:1 | 10.09:1 |
| text-foreground on a teal status tile | 8.94:1 | 10.02:1 |
| success as text on bg-background | 9.86:1 | 6.01:1 |
| success as text on bg-surface | 8.92:1 | 6.59:1 |
| success as text on bg-surface-2 | 7.90:1 | 5.57:1 |
| warning as text on bg-background | 12.96:1 | 8.69:1 |
| warning as text on bg-surface | 11.73:1 | 9.52:1 |
| warning as text on bg-surface-2 | 10.39:1 | 8.06:1 |
| danger as text on bg-background | 7.04:1 | 5.85:1 |
| danger as text on bg-surface | 6.37:1 | 6.41:1 |
| danger as text on bg-surface-2 | 5.65:1 | 5.43:1 |
| info as text on bg-background | 9.07:1 | 5.70:1 |
| info as text on bg-surface | 8.21:1 | 6.24:1 |
| info as text on bg-surface-2 | 7.27:1 | 5.28:1 |
| neutral as text on bg-background | 7.81:1 | 5.86:1 |
| neutral as text on bg-surface | 7.07:1 | 6.42:1 |
| neutral as text on bg-surface-2 | 6.26:1 | 5.43:1 |
| orange as text on bg-background | 12.96:1 | 6.20:1 |
| orange as text on bg-surface | 11.73:1 | 6.79:1 |
| orange as text on bg-surface-2 | 10.39:1 | 5.75:1 |
| purple as text on bg-background | 6.26:1 | 6.80:1 |
| purple as text on bg-surface | 5.67:1 | 7.45:1 |
| purple as text on bg-surface-2 | 5.02:1 | 6.31:1 |
| teal as text on bg-background | 6.41:1 | 6.87:1 |
| teal as text on bg-surface | 5.80:1 | 7.53:1 |
| teal as text on bg-surface-2 | 5.14:1 | 6.37:1 |
| chart text on bg-background | 7.81:1 | 5.86:1 |
| chart text on bg-surface | 7.07:1 | 6.42:1 |
| chart text on bg-surface-2 | 6.26:1 | 5.43:1 |
| chart series 1 on bg-surface | 8.21:1 | 5.26:1 |
| chart series 2 on bg-surface | 11.73:1 | 3.49:1 |
| chart series 3 on bg-surface | 9.57:1 | 3.50:1 |
| chart series 4 on bg-surface | 5.86:1 | 3.99:1 |
| chart series 5 on bg-surface | 5.67:1 | 7.45:1 |
| chart series 6 on bg-surface | 5.90:1 | 4.74:1 |
| chart series 7 on bg-surface | 12.82:1 | 12.58:1 |
| chart series 8 on bg-surface | 5.80:1 | 7.53:1 |
| warning as a fill on bg-surface | 11.73:1 | 3.22:1 |
| orange as a fill on bg-surface | 11.73:1 | 3.49:1 |
| primary button | 9.07:1 | 6.24:1 |
| danger button | 7.04:1 | 6.41:1 |

### paper

| Pairing | Dark | Light |
| --- | --- | --- |
| text-foreground on bg-background | 15.57:1 | 17.01:1 |
| text-foreground on bg-surface | 14.24:1 | 18.23:1 |
| text-foreground on bg-surface-2 | 12.47:1 | 15.97:1 |
| text-muted on bg-background | 7.74:1 | 6.19:1 |
| text-muted on bg-surface | 7.08:1 | 6.64:1 |
| text-muted on bg-surface-2 | 6.20:1 | 5.82:1 |
| text-primary on bg-background | 7.67:1 | 6.91:1 |
| text-primary on bg-surface | 7.02:1 | 7.41:1 |
| text-primary on bg-surface-2 | 6.15:1 | 6.49:1 |
| text-danger on bg-background | 7.26:1 | 5.97:1 |
| text-danger on bg-surface | 6.64:1 | 6.41:1 |
| text-danger on bg-surface-2 | 5.82:1 | 5.61:1 |
| text-warning on bg-background | 10.13:1 | 9.20:1 |
| text-warning on bg-surface | 9.26:1 | 9.86:1 |
| text-warning on bg-surface-2 | 8.11:1 | 8.64:1 |
| text-success on bg-background | 10.42:1 | 6.40:1 |
| text-success on bg-surface | 9.53:1 | 6.86:1 |
| text-success on bg-surface-2 | 8.35:1 | 6.01:1 |
| text-foreground on hover:bg-surface-3 | 10.70:1 | 14.41:1 |
| text-danger on bg-danger/5 (badges, alerts) | 6.16:1 | 5.90:1 |
| text-danger on bg-danger/10 (badges, alerts) | 5.66:1 | 5.43:1 |
| text-danger on bg-danger/15 (badges, alerts) | 5.18:1 | 4.98:1 |
| text-danger on bg-danger/20 (badges, alerts) | 4.69:1 | 4.59:1 |
| text-warning on bg-warning/5 (badges, alerts) | 8.40:1 | 9.06:1 |
| text-warning on bg-warning/10 (badges, alerts) | 7.53:1 | 8.35:1 |
| text-warning on bg-warning/15 (badges, alerts) | 6.75:1 | 7.63:1 |
| text-warning on bg-warning/20 (badges, alerts) | 5.96:1 | 6.95:1 |
| text-success on bg-success/5 (badges, alerts) | 8.68:1 | 6.38:1 |
| text-success on bg-success/10 (badges, alerts) | 7.74:1 | 5.88:1 |
| text-success on bg-success/15 (badges, alerts) | 6.88:1 | 5.45:1 |
| text-success on bg-success/20 (badges, alerts) | 6.10:1 | 5.00:1 |
| text-primary on bg-primary/10 | 5.94:1 | 6.35:1 |
| text-foreground on a success status tile | 7.93:1 | 11.80:1 |
| text-foreground on a warning status tile | 7.97:1 | 13.14:1 |
| text-foreground on a danger status tile | 8.87:1 | 11.60:1 |
| text-foreground on a info status tile | 8.61:1 | 11.79:1 |
| text-foreground on a neutral status tile | 8.52:1 | 12.12:1 |
| text-foreground on a orange status tile | 8.06:1 | 12.96:1 |
| text-foreground on a purple status tile | 9.00:1 | 11.69:1 |
| text-foreground on a teal status tile | 8.49:1 | 11.48:1 |
| success as text on bg-background | 10.42:1 | 6.40:1 |
| success as text on bg-surface | 9.53:1 | 6.86:1 |
| success as text on bg-surface-2 | 8.35:1 | 6.01:1 |
| warning as text on bg-background | 10.13:1 | 9.20:1 |
| warning as text on bg-surface | 9.26:1 | 9.86:1 |
| warning as text on bg-surface-2 | 8.11:1 | 8.64:1 |
| danger as text on bg-background | 7.26:1 | 5.97:1 |
| danger as text on bg-surface | 6.64:1 | 6.41:1 |
| danger as text on bg-surface-2 | 5.82:1 | 5.61:1 |
| info as text on bg-background | 7.67:1 | 6.91:1 |
| info as text on bg-surface | 7.02:1 | 7.41:1 |
| info as text on bg-surface-2 | 6.15:1 | 6.49:1 |
| neutral as text on bg-background | 7.74:1 | 6.19:1 |
| neutral as text on bg-surface | 7.08:1 | 6.64:1 |
| neutral as text on bg-surface-2 | 6.20:1 | 5.82:1 |
| orange as text on bg-background | 9.75:1 | 5.11:1 |
| orange as text on bg-surface | 8.92:1 | 5.48:1 |
| orange as text on bg-surface-2 | 7.81:1 | 4.80:1 |
| purple as text on bg-background | 6.56:1 | 7.22:1 |
| purple as text on bg-surface | 6.00:1 | 7.75:1 |
| purple as text on bg-surface-2 | 5.26:1 | 6.79:1 |
| teal as text on bg-background | 8.31:1 | 8.06:1 |
| teal as text on bg-surface | 7.60:1 | 8.64:1 |
| teal as text on bg-surface-2 | 6.66:1 | 7.57:1 |
| chart text on bg-background | 7.74:1 | 6.19:1 |
| chart text on bg-surface | 7.08:1 | 6.64:1 |
| chart text on bg-surface-2 | 6.20:1 | 5.82:1 |
| chart series 1 on bg-surface | 7.02:1 | 7.41:1 |
| chart series 2 on bg-surface | 8.31:1 | 6.18:1 |
| chart series 3 on bg-surface | 8.92:1 | 3.62:1 |
| chart series 4 on bg-surface | 5.92:1 | 8.21:1 |
| chart series 5 on bg-surface | 6.00:1 | 7.75:1 |
| chart series 6 on bg-surface | 7.60:1 | 8.64:1 |
| chart series 7 on bg-surface | 5.43:1 | 6.42:1 |
| chart series 8 on bg-surface | 12.58:1 | 12.26:1 |
| warning as a fill on bg-surface | 9.26:1 | 3.21:1 |
| orange as a fill on bg-surface | 8.92:1 | 3.62:1 |
| primary button | 7.67:1 | 7.21:1 |
| danger button | 7.26:1 | 6.23:1 |

### high-contrast

| Pairing | Dark | Light |
| --- | --- | --- |
| text-foreground on bg-background | 20.62:1 | 21.00:1 |
| text-foreground on bg-surface | 20.50:1 | 20.47:1 |
| text-foreground on bg-surface-2 | 19.17:1 | 18.43:1 |
| text-muted on bg-background | 14.33:1 | 10.86:1 |
| text-muted on bg-surface | 14.24:1 | 10.59:1 |
| text-muted on bg-surface-2 | 13.32:1 | 9.53:1 |
| text-primary on bg-background | 11.91:1 | 9.75:1 |
| text-primary on bg-surface | 11.84:1 | 9.50:1 |
| text-primary on bg-surface-2 | 11.07:1 | 8.55:1 |
| text-danger on bg-background | 8.66:1 | 8.05:1 |
| text-danger on bg-surface | 8.61:1 | 7.84:1 |
| text-danger on bg-surface-2 | 8.05:1 | 7.06:1 |
| text-warning on bg-background | 16.07:1 | 12.89:1 |
| text-warning on bg-surface | 15.98:1 | 12.57:1 |
| text-warning on bg-surface-2 | 14.94:1 | 11.31:1 |
| text-success on bg-background | 13.41:1 | 9.17:1 |
| text-success on bg-surface | 13.33:1 | 8.93:1 |
| text-success on bg-surface-2 | 12.47:1 | 8.04:1 |
| text-foreground on hover:bg-surface-3 | 16.48:1 | 16.06:1 |
| text-danger on bg-danger/5 (badges, alerts) | 8.66:1 | 8.05:1 |
| text-danger on bg-danger/10 (badges, alerts) | 8.66:1 | 8.05:1 |
| text-danger on bg-danger/15 (badges, alerts) | 8.66:1 | 8.05:1 |
| text-danger on bg-danger/20 (badges, alerts) | 8.66:1 | 8.05:1 |
| text-warning on bg-warning/5 (badges, alerts) | 16.07:1 | 12.89:1 |
| text-warning on bg-warning/10 (badges, alerts) | 16.07:1 | 12.89:1 |
| text-warning on bg-warning/15 (badges, alerts) | 16.07:1 | 12.89:1 |
| text-warning on bg-warning/20 (badges, alerts) | 16.07:1 | 12.89:1 |
| text-success on bg-success/5 (badges, alerts) | 13.41:1 | 9.17:1 |
| text-success on bg-success/10 (badges, alerts) | 13.41:1 | 9.17:1 |
| text-success on bg-success/15 (badges, alerts) | 13.41:1 | 9.17:1 |
| text-success on bg-success/20 (badges, alerts) | 13.41:1 | 9.17:1 |
| text-primary on bg-primary/10 | 10.38:1 | 7.94:1 |
| text-foreground on a success status tile | 13.41:1 | 9.17:1 |
| text-foreground on a warning status tile | 16.07:1 | 12.89:1 |
| text-foreground on a danger status tile | 8.66:1 | 8.05:1 |
| text-foreground on a info status tile | 11.91:1 | 9.75:1 |
| text-foreground on a neutral status tile | 14.33:1 | 10.86:1 |
| text-foreground on a orange status tile | 10.67:1 | 6.22:1 |
| text-foreground on a purple status tile | 7.80:1 | 6.65:1 |
| text-foreground on a teal status tile | 7.07:1 | 6.20:1 |
| success as text on bg-background | 13.41:1 | 9.17:1 |
| success as text on bg-surface | 13.33:1 | 8.93:1 |
| success as text on bg-surface-2 | 12.47:1 | 8.04:1 |
| warning as text on bg-background | 16.07:1 | 12.89:1 |
| warning as text on bg-surface | 15.98:1 | 12.57:1 |
| warning as text on bg-surface-2 | 14.94:1 | 11.31:1 |
| danger as text on bg-background | 8.66:1 | 8.05:1 |
| danger as text on bg-surface | 8.61:1 | 7.84:1 |
| danger as text on bg-surface-2 | 8.05:1 | 7.06:1 |
| info as text on bg-background | 11.91:1 | 9.75:1 |
| info as text on bg-surface | 11.84:1 | 9.50:1 |
| info as text on bg-surface-2 | 11.07:1 | 8.55:1 |
| neutral as text on bg-background | 14.33:1 | 10.86:1 |
| neutral as text on bg-surface | 14.24:1 | 10.59:1 |
| neutral as text on bg-surface-2 | 13.32:1 | 9.53:1 |
| orange as text on bg-background | 10.67:1 | 6.22:1 |
| orange as text on bg-surface | 10.61:1 | 6.06:1 |
| orange as text on bg-surface-2 | 9.92:1 | 5.46:1 |
| purple as text on bg-background | 7.80:1 | 6.65:1 |
| purple as text on bg-surface | 7.75:1 | 6.49:1 |
| purple as text on bg-surface-2 | 7.25:1 | 5.84:1 |
| teal as text on bg-background | 7.07:1 | 6.20:1 |
| teal as text on bg-surface | 7.03:1 | 6.04:1 |
| teal as text on bg-surface-2 | 6.57:1 | 5.44:1 |
| chart text on bg-background | 14.33:1 | 10.86:1 |
| chart text on bg-surface | 14.24:1 | 10.59:1 |
| chart text on bg-surface-2 | 13.32:1 | 9.53:1 |
| chart series 1 on bg-surface | 11.84:1 | 9.50:1 |
| chart series 2 on bg-surface | 14.27:1 | 6.25:1 |
| chart series 3 on bg-surface | 10.61:1 | 6.06:1 |
| chart series 4 on bg-surface | 6.87:1 | 4.27:1 |
| chart series 5 on bg-surface | 7.75:1 | 6.49:1 |
| chart series 6 on bg-surface | 7.03:1 | 6.04:1 |
| chart series 7 on bg-surface | 5.87:1 | 11.46:1 |
| chart series 8 on bg-surface | 17.64:1 | 15.51:1 |
| warning as a fill on bg-surface | 15.98:1 | 12.57:1 |
| orange as a fill on bg-surface | 10.61:1 | 6.06:1 |
| primary button | 11.91:1 | 9.75:1 |
| danger button | 8.66:1 | 8.05:1 |

## High contrast and forced colors

The High contrast theme holds every text at 7:1 and every border at 4.5:1,
and draws tints as solid fills. Its tables are above, and its rules are on
[Theming](/architecture/theming/#quality-bar). Under the operating system's
forced colors, filled and tinted elements get an outline and focus is drawn
in `Highlight`. Charts redraw in system colors
([Theming](/architecture/theming/#forced-colors)). The e2e suite emulates
forced colors and checks the chart opt-out, the outlines and the focus
color directly. axe-core cannot measure contrast in that mode.

![A line chart under forced colors: white axes and labels on black, series in the system's cyan, yellow and white.](/images/themes/forced-colors.png)

## Automated checks

Every check, what it tests and which CI job runs it, and the manual checks
before a release, are under
[How it is checked](/reference/accessibility/#how-it-is-checked) in the
accessibility statement. That every pairing meets AA in every theme is the
unit tests' job (`test/contrast.test.ts`, `test/theme-quality.test.ts`); the
browser proves each surface is built right (`e2e/a11y.spec.ts`), which does
not change with the theme.

---

*Last verified against the code at commit `4e4c5cf` (2026-10-05).*
