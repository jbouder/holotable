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
| Text and lines | `--foreground`, `--muted`, `--border`, `--border-strong` | Body text, secondary text, card edges, control edges |
| Accent | `--primary`, `--primary-foreground` | Links, primary buttons |
| Focus and selection | `--ring`, `--selection` | The focus outline, selected text |
| Code | `--code-keyword`, `--code-string`, `--code-number`, `--code-comment` | SQL and PromQL highlighting |
| Tints | `--tint-5` … `--tint-20`, `--tint-<status>`, `--tint-foreground`, `--tinted-*` | Status notices, badges and tiles (below) |

## Status tints

A notice, a badge or a status tile is its status color at a low alpha, with
the status as its text. Markup draws one as
`tinted bg-tint-<status>/(--tint-<n>)`:

- `--tint-<n>` is the alpha, `10%` and so on, and a theme may change it.
  High contrast sets every one to `100%`, so tints become solid fills.
- `bg-tint-<status>` reads `--tint-<status>`. It is fixed on the theme's own
  element, so it keeps the status color inside the tint.
- `.tinted` points `--foreground`, `--muted` and the three status colors at
  the `--tinted-*` inks. They are the page's own colors in every theme but
  high contrast, where they are `--tint-foreground`, the ink that reads on a
  solid fill.

No component asks which theme is on, and `test/color-literals.test.ts` holds
both rules: no bare `bg-<status>/<n>` tint, and no theme comparison in a
component. `CONTRAST_PAIRS` measures each tint at its theme's alpha and ink.

## Forced colors

The operating system's forced colors (`@media (forced-colors: active)`)
replace every color and strip backgrounds. `globals.css` gives tinted and
filled elements an outline, since their fill no longer tells them apart, and
draws focus in `Highlight`. A chart's container opts out of the adjustment
(`forced-color-adjust: none`), because the system cannot recolor a canvas.
`useChartTheme` then reads `forcedColorsTheme`: text and lines in
`CanvasText` on `Canvas`, with series from the few other system colors.
`e2e/a11y.spec.ts` emulates forced colors and asserts these rules directly.
axe-core does not model forced colors: it would measure the page's own
colors against the system's background.
| Status | `--success`, `--warning`, `--danger` | Badges, alerts, thresholds |
| Chart series | `--chart-1` … `--chart-8` | Categorical series, each at least 3:1 on `--surface` |
| Chart ramps | `--chart-seq-1` … `--chart-seq-5`, `--chart-div-low/mid/high` | Sequential and diverging scales |
| Chart chrome | `--chart-text`, `--chart-axis`, `--chart-grid` | Axis labels, axis lines, grid lines |

A spec never names a color, only a color token. `src/lib/panels/colors.ts`
maps each one to a variable, for example `success` to `--success` and `teal`
to `--teal`. Holotable aliases `--orange`, `--purple` and `--teal` to
`--chart-3`, `--chart-5` and `--chart-6`. A theme that orders its series
differently points each one at the series of the same color family, so a
spec's `teal` is teal in every theme. Markup uses the variable, and a canvas reads its value
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

## Shipped themes

Holotable, Graphite, Fjord, Paper and High contrast ship, each in both
schemes. The
[Themes](/guide/themes/) guide shows them and says what each is for. A
theme sets every color token itself, so its intent does not depend on
Holotable's values, and inherits only the aliases (`--chart-text`, the
`--code-*` colors). Paper also sets `--radius`, the only theme that rounds.

An operator can add one more without a pull request: `THEME_FILE`, a JSON
file of token values held to the operator tier at boot. The root layout
renders its two blocks from the parsed numbers in a `<style>` under the CSP
nonce, and `paletteInfo()` lists it beside the built-ins, on the server and,
through `<html data-operator-palette>`, in the browser. See
[Your own theme](/admin/themes/).

Adding a built-in theme takes its two blocks in `globals.css` and an entry in
`PALETTE_INFO`. `test/theme-quality.test.ts` checks that the two lists
match, and that the new blocks clear the quality bar.

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
code. In a browser, `e2e/a11y.spec.ts` scans every surface in Holotable's
two schemes and the live dashboard in every other shipped theme's two
schemes: the measuring is done here, and the browser proves the theme
switch reaches a real page.

## Quality bar

Contrast is the floor, not the bar. `src/lib/color/quality.ts` holds each
theme, in each scheme, to rules that contrast alone does not cover, and
`test/theme-quality.test.ts` fails on any of them. `npm run themes:check`
prints every measurement as a table for whoever is tuning a theme, each
theme at the tier the test holds it to (`-- --operator` puts every theme at
the operator tier).

| Rule | Measures | Floor |
| --- | --- | --- |
| `surface-ladder` | Each surface's OKLab lightness step from the one below | ΔL 0.015 |
| `foreground` | Body text on every surface | 7:1 built-in, 4.5:1 operator |
| `muted` | Secondary text on every surface | 4.5:1 |
| `border` | `--border` and `--border-strong` on every surface | 1.3:1 and 3:1 |
| `primary` | The accent as text, as a fill, and its hue from each status | 4.5:1, 3:1, 60° |
| `on-fill` | `--primary-foreground` on the primary and danger fills | 4.5:1 |
| `status-distinct` | Success, warning and danger from each other, plainly and under protanopia, deuteranopia and tritanopia | ΔE 0.12, 0.05 |
| `chart-series` | Each series on the surface, and the closest two, plainly and under each deficiency | 3:1, ΔE 0.08, 0.02 |
| `chart-text` | Axis text on the surface | 4.5:1 |
| `ring` | The focus ring on every surface | 3:1 |
| `selection` | Body text on the selection | 4.5:1 |
| `code` | Each syntax color on the surface | 4.5:1 |

Distances are Euclidean in OKLab. Color-vision deficiencies are simulated
with the Machado, Oliveira and Fernandes (2009) matrices at full severity
(`src/lib/color/cvd.ts`).

The ring is measured against the surfaces, not the fills. A filled button
draws its outline 2px out (`outline-offset-2`), so a band of surface always
sits between the ring and the fill. One ring color can then work on every
fill without a contrast pair for each.

The built-in themes are held to the built-in tier. A theme file an operator
supplies is checked at the operator tier, which relaxes body text to AA. High
contrast (`highContrast` in `PALETTE_INFO`) has its own, stricter tier:

| Floor | Built in | High contrast |
| --- | --- | --- |
| Body text | 7:1 | 12:1 |
| Every other text, statuses included | 4.5:1 | 7:1 |
| `--border` / `--border-strong` | 1.3:1 / 3:1 | 4.5:1 / 4.5:1 |
| A label on a solid fill | 4.5:1 | 7:1 |
| Surface ladder | ΔL 0.015 | none; borders carry it |
| `--chart-grid` on the surface | none | 3:1 |
| `--tint-foreground` on each solid status fill | none | 7:1 |

Statuses as text (`status-text`) are measured in every tier.
