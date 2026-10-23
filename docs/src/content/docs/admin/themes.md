---
title: Your own theme
description: Add a theme of your own with THEME_FILE, a JSON file of token values checked at boot.
---

Holotable ships five themes. You can add one more without changing the code:
a JSON file of color values that the server reads at boot, checks, and offers
beside the built-in themes. It appears in the account menu, the command
palette, the theme gallery in **Settings → Appearance** and the share dialog,
and charts, the editor and custom visuals use its colors.

It is a set of numbers, not a stylesheet. It cannot change the logo, the
product name or the fonts, and a value that is not a color is refused.

## Setting it up

1. Start from a built-in theme:

   ```bash
   npm run --silent themes:export graphite -- --as acme > acme.json
   ```

2. Edit the values, then point `THEME_FILE` at the file (an absolute path):

   ```bash
   THEME_FILE=/etc/holotable/theme/acme.json
   ```

3. To make it what a new browser starts with, also set
   `THEME_DEFAULT_PALETTE` to its `name`.

4. Check it before you deploy: `npm run config:check` runs the same checks as
   boot.

With the Helm chart, put the file's contents under `theme.file` in your
values. The chart renders it into a ConfigMap, mounts it and sets
`THEME_FILE`. See the chart's README.

## The file

| Field | Required | What it is |
| --- | --- | --- |
| `name` | Yes | 2–32 lowercase letters, digits and dashes, starting with a letter. Not a built-in theme's name. |
| `label` | Yes | What the theme controls show, up to 40 characters. |
| `description` | No | One sentence for the gallery, up to 120 characters. |
| `radius` | No | Corner rounding: `0px`, `2px`, `4px` or `6px`. Square when absent. |
| `shadow` | No | How far a card lifts off the page: `none`, `subtle` or `lifted` (Holotable's). Written per scheme for you, since a shadow that reads on a light page vanishes on a dark one. `subtle` when absent. |
| `light`, `dark` | Yes | Every token below, in each scheme. |

Each token is `oklch(L C H)`, with L from 0 to 1 (or 0–100%), C from 0 to
0.5 and H from 0 to 360, or `#rrggbb`. Any other key, in the file or in a
scheme, is refused.

| Tokens | Used for |
| --- | --- |
| `background`, `surface`, `surface-2`, `surface-3` | The page, cards, insets, hover fills |
| `foreground`, `muted` | Body text, secondary text |
| `border`, `border-strong` | Card edges, control edges |
| `ring`, `selection` | The focus outline, selected text |
| `primary`, `primary-foreground` | The accent, and the label on it |
| `danger`, `warning`, `success` | Statuses |
| `chart-1` … `chart-8` | Chart series, in order |
| `chart-seq-1` … `chart-seq-5`, `chart-div-low`, `chart-div-mid`, `chart-div-high` | Sequential and diverging scales |
| `orange`, `purple`, `teal` | Which series a spec's `orange`, `purple` and `teal` mean |
| `code-keyword`, `code-string`, `code-number`, `code-comment` | SQL and PromQL highlighting |
| `chart-grid` (optional) | Chart gridlines; the scheme's `surface-2` when absent |

Chart text, axis lines, and status tints follow from these the same way they
do for a built-in theme. A file written before `shadow` and `chart-grid`
existed still loads, and looks as it did.

## What it is held to

Every pairing in the [contrast table](/architecture/accessibility/#contrast)
at WCAG AA, and the [quality bar](/architecture/theming/#quality-bar) at the
operator tier. The operator tier is the built-in bar with body text relaxed
from 7:1 to AA. It covers visible borders and focus, readable selection and
code colors, the accent apart from the statuses, and statuses and chart
series that stay apart under color-vision deficiencies.

In production a file that fails stops the server from starting. Each failure
is named with its scheme and number:

```text
THEME_FILE: text-muted on bg-surface-2, light: 4.20:1 (needs 4.5:1)
```

In development it is a warning, and the server runs on the built-in themes.
A `THEME_DEFAULT_PALETTE` naming that theme then falls back to Holotable, with
a warning.
A file that cannot be read is an error everywhere.

The High contrast theme exports too, but it is held to a stricter tier of its
own, and its nearly flat surfaces fall below the operator tier's surface
step. Start from another theme instead.

## Example

Graphite's values, as `npm run --silent themes:export graphite -- --as acme` writes
them. The file passes the checks unchanged.

```json
{
  "name": "acme",
  "label": "Acme",
  "description": "Warm neutral grays and a violet accent, so the data is the only color.",
  "light": {
    "background": "oklch(0.97 0.003 80)",
    "surface": "oklch(0.995 0.002 80)",
    "surface-2": "oklch(0.94 0.004 80)",
    "surface-3": "oklch(0.9 0.005 80)",
    "foreground": "oklch(0.2 0.005 70)",
    "muted": "oklch(0.49 0.006 70)",
    "border": "oklch(0.85 0.005 80)",
    "border-strong": "oklch(0.56 0.006 70)",
    "ring": "oklch(0.15 0.005 70)",
    "selection": "oklch(0.9 0.05 300)",
    "primary": "oklch(0.5 0.18 300)",
    "primary-foreground": "oklch(0.98 0.003 80)",
    "danger": "oklch(0.5 0.17 22)",
    "warning": "oklch(0.45 0.11 75)",
    "success": "oklch(0.46 0.11 158)",
    "chart-1": "oklch(0.48 0.18 300)",
    "chart-2": "oklch(0.6 0.13 245)",
    "chart-3": "oklch(0.5 0.09 195)",
    "chart-4": "oklch(0.5 0.11 70)",
    "chart-5": "oklch(0.54 0.18 22)",
    "chart-6": "oklch(0.5 0.12 145)",
    "chart-7": "oklch(0.52 0.18 345)",
    "chart-8": "oklch(0.34 0.06 90)",
    "chart-seq-1": "oklch(0.93 0.03 300)",
    "chart-seq-2": "oklch(0.8 0.07 300)",
    "chart-seq-3": "oklch(0.66 0.12 300)",
    "chart-seq-4": "oklch(0.52 0.16 300)",
    "chart-seq-5": "oklch(0.38 0.13 300)",
    "chart-div-low": "oklch(0.5 0.15 255)",
    "chart-div-mid": "oklch(0.93 0.004 80)",
    "chart-div-high": "oklch(0.54 0.18 22)",
    "orange": "oklch(0.5 0.11 70)",
    "purple": "oklch(0.48 0.18 300)",
    "teal": "oklch(0.5 0.09 195)",
    "code-keyword": "oklch(0.5 0.18 300)",
    "code-string": "oklch(0.46 0.11 158)",
    "code-number": "oklch(0.45 0.11 75)",
    "code-comment": "oklch(0.49 0.006 70)"
  },
  "dark": {
    "background": "oklch(0.17 0.004 70)",
    "surface": "oklch(0.21 0.005 70)",
    "surface-2": "oklch(0.255 0.005 70)",
    "surface-3": "oklch(0.3 0.005 70)",
    "foreground": "oklch(0.95 0.004 80)",
    "muted": "oklch(0.71 0.006 75)",
    "border": "oklch(0.35 0.005 70)",
    "border-strong": "oklch(0.56 0.006 70)",
    "ring": "oklch(0.99 0 0)",
    "selection": "oklch(0.4 0.08 300)",
    "primary": "oklch(0.72 0.15 300)",
    "primary-foreground": "oklch(0.17 0.004 70)",
    "danger": "oklch(0.72 0.16 22)",
    "warning": "oklch(0.8 0.13 78)",
    "success": "oklch(0.79 0.13 158)",
    "chart-1": "oklch(0.75 0.14 300)",
    "chart-2": "oklch(0.62 0.14 250)",
    "chart-3": "oklch(0.76 0.11 190)",
    "chart-4": "oklch(0.8 0.14 75)",
    "chart-5": "oklch(0.68 0.17 22)",
    "chart-6": "oklch(0.74 0.14 145)",
    "chart-7": "oklch(0.66 0.18 345)",
    "chart-8": "oklch(0.9 0.04 100)",
    "chart-seq-1": "oklch(0.32 0.05 300)",
    "chart-seq-2": "oklch(0.45 0.09 300)",
    "chart-seq-3": "oklch(0.58 0.13 300)",
    "chart-seq-4": "oklch(0.72 0.12 295)",
    "chart-seq-5": "oklch(0.86 0.07 290)",
    "chart-div-low": "oklch(0.68 0.14 250)",
    "chart-div-mid": "oklch(0.36 0.005 70)",
    "chart-div-high": "oklch(0.68 0.17 22)",
    "orange": "oklch(0.8 0.14 75)",
    "purple": "oklch(0.75 0.14 300)",
    "teal": "oklch(0.76 0.11 190)",
    "code-keyword": "oklch(0.72 0.15 300)",
    "code-string": "oklch(0.79 0.13 158)",
    "code-number": "oklch(0.8 0.13 78)",
    "code-comment": "oklch(0.71 0.006 75)"
  }
}
```
