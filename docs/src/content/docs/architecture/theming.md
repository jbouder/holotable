---
title: Theming
description: The token set, the scheme and the named theme, the selector convention, and how a theme reaches first paint, charts and the contrast tests.
---

The page's colors are CSS custom properties in `src/app/globals.css`, authored
in OKLCH. Two independent choices decide which values apply. The **color
scheme** is light or dark, on `<html data-theme>`. The **theme** is a named,
designed set of colors that comes in both schemes, on `<html data-palette>`
([#501](https://github.com/jbouder/holotable/issues/501)).

## The tokens

| Group | Tokens | Used for |
| --- | --- | --- |
| Surfaces | `--background`, `--surface`, `--surface-2`, `--surface-3` | The page, cards, insets, hover fills |
| Text and lines | `--foreground`, `--muted`, `--border` | Body text, secondary text, borders |
| Accent | `--primary`, `--primary-foreground` | Links, primary buttons, focus |
| Status | `--success`, `--warning`, `--danger` | Badges, alerts, thresholds |
| Chart series | `--chart-1` … `--chart-8` | Categorical series, each at least 3:1 on `--surface` |
| Chart ramps | `--chart-seq-1` … `--chart-seq-5`, `--chart-div-low/mid/high` | Sequential and diverging scales |
| Chart chrome | `--chart-text`, `--chart-axis`, `--chart-grid` | Axis labels, axis lines, grid lines |

A spec never names a color, only a color token. `src/lib/panels/colors.ts`
maps each one to a variable, for example `success` to `--success` and `teal`
to `--chart-6`. Markup uses the variable, and a canvas reads its value
through `ChartTheme` (`src/lib/color/chart-theme.ts`), which converts the
computed style off `<html>`.
`test/color-literals.test.ts` keeps color literals out of `src/`, except in
`src/lib/color/` and `globals.css`.

## Selector convention

- Holotable is the two unqualified blocks: `:root, [data-theme="dark"]` and
  `[data-theme="light"]`. A page with no `data-palette`, or with
  `data-palette="holotable"`, is Holotable.
- Any other theme is `[data-palette="<name>"][data-theme="dark"]` and
  `[data-palette="<name>"][data-theme="light"]`. It sets only the tokens it
  changes, and the cascade supplies the rest from Holotable's block for the
  same scheme.
- Both attributes work on any element, so a preview card can show a theme
  inside a page drawn in another.

## Reaching first paint

`src/lib/theme.ts` owns both choices: the stored keys `theme` and `palette`,
the `PALETTES` names (reserved and shipped), `PALETTE_INFO` (what is
shipped and offered), and the change events. The inline bootstrap script
(`src/lib/bootstrap.ts`) writes `data-theme` and `data-palette` before the
page draws. A stored palette the app does not ship falls back to the
server's default, `THEME_DEFAULT_PALETTE`. `validateConfig` refuses a name
outside the shipped list at boot. Every control changes the theme through
`src/lib/theme-transition.ts`, under the `theme` view transition, and charts
re-read their colors when either attribute changes.

## Measured

`src/lib/color/contrast.ts` parses every theme block it finds, and measures
`CONTRAST_PAIRS` in each one on top of Holotable's values for the same scheme.
Text is held to AA, and a chart series to the 3:1 non-text floor. The table
on [Accessibility](/architecture/accessibility/) is generated from the same
code, and `e2e/a11y.spec.ts` scans every shipped theme in both schemes.
