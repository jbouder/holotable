---
title: Panel options
description: The options each panel kind takes in `panel.options`, and how the kinds added in M11 read their rows.
sidebar:
  order: 3
---

A panel's `options` belong to its kind. The IR validates them against that
kind's schema (`src/lib/panels/kinds/` and `src/lib/panels/presentation.ts`),
so a gauge's options on a pie panel are refused, and so is a field a kind does
not know. `heatmap` and `scatter` take no options. Every option is optional,
and a panel without `options` renders exactly as it did before they existed
([#115](https://github.com/jbouder/holotable/issues/115)).

In the editor, the shared groups below get their own controls, and every kind
with options also has an **All options (JSON)** box that is checked as you type.

Colors are always token names, never raw colors:
`success`, `warning`, `danger`, `info`, `neutral`, `orange`, `purple`, `teal`.
They resolve through the same OKLCH values as the theme (invariant 13).

## Shared groups

### Numbers

Taken by `line`, `area`, `bar`, `stat`, `pie`, `donut`, `gauge` and
`status-grid`, and by each
entry of a table's `columns`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `decimals` | integer, 0 to 6 | the format's own rounding | Digits after the point, fixed. |
| `unit` | string, up to 16 characters | none | Written after the number: `12 hosts`. A unit starting with `/` or `%` is joined to it: `4.1 KB/s`. |
| `compact` | boolean | `false` | `1.2K` rather than `1,234`. `bytes` is compact already. |

`panel.format` still picks bytes, percent or milliseconds. On a chart, values
are written per the format and these options only once the panel has one of
them; without, the axis and tooltip show values as they always have.

### Thresholds

Taken by `line`, `area`, `bar`, `stat`, `gauge` and `status-grid`:
`[{ value, color }]`,
strictly ascending, at most 10. A value takes the color of the last step at or
below it.

- **`stat`**: the number is drawn in the step's color. Below the first step it
  keeps the default text color.
- **`line`, `area`, `bar`**: a hidden piecewise visual map colors each segment,
  fill and bar by its value, so every series takes the step colors. Below the
  first step, a value takes the first chart color.

### Legend and axis

| Option | Kinds | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `legend` | series, `pie`, `donut` | `"top"` \| `"bottom"` \| `"right"` \| `"none"` | `"top"` | Where the legend sits. |
| `yAxis.min`, `yAxis.max` | series | number | automatic | Fixed bounds; `min` must be below `max`. |
| `yAxis.log` | series | boolean | `false` | A log10 scale. `min`, when given, must be above zero. |
| `yAxis.label` | series | string, up to 64 | none | The axis title. |
| `stacked` | series | boolean | `false` | Series drawn on top of each other. |

"Series" is `line`, `area` and `bar`. A chart is drawn anew when its options
change, because a merged `setOption` cannot take back a visual map, a stack or
an axis bound; only authoring changes them, so a data update still merges
(invariant 11).

```json
{
  "viz": "line",
  "format": "ms",
  "options": {
    "decimals": 0,
    "legend": "bottom",
    "yAxis": { "min": 0, "label": "p95 latency" },
    "thresholds": [
      { "value": 0, "color": "success" },
      { "value": 250, "color": "warning" },
      { "value": 1000, "color": "danger" }
    ]
  }
}
```

## `stat`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `value` | column name | the last row's first numeric column that is not the time field | The column shown. A name the result lacks falls back to the default. |
| `sparkline` | boolean | `false` | The value column across every row, drawn faintly behind the number in its color. |

Plus the number options and thresholds above.

## `table`

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `columns` | `[{ name, label?, hidden?, format?, decimals?, unit?, compact?, align?, width? }]`, at most 50 | none | Listed columns come first, in this order, and the rest follow as the query returned them. A listed column the result lacks is skipped. |
| `sort` | `{ column, order? }` | the query's order | `order` is `"asc"` (the default) or `"desc"`. Numbers sort as numbers, empty cells last. |

- `label` is the header; `hidden: true` leaves the column out.
- `format` (`number`, `bytes`, `percent`, `ms`) and the number options write a
  numeric cell; without them a cell is shown as returned.
- `align` is `left`, `center` or `right`; `width` is in pixels, 40 to 800.
- Without `sort` the table shows the newest 100 rows, as before; with one, the
  first 100 in its order.

The editor's **Columns** section edits names, headers, format, alignment,
visibility and order; `width`, `decimals` and `unit` per column are edited in
the JSON box.

## `gauge`

One value against its limits ([#200](https://github.com/jbouder/holotable/issues/200)).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `variant` | `"radial"` \| `"bar"` | `"radial"` | A dial for one value, or one horizontal bar per row. |
| `value` | column name | first numeric column | The column shown. |
| `min` | number or column name | `0` | The low limit. A column name reads it from the row. |
| `max` | number or column name | `100` | The high limit. |
| `thresholds` | `[{ value, color }]`, ascending, at most 10 | none | A value takes the color of the last step at or below it. Below the first step, or with none, it is `info`. |
| `decimals`, `unit`, `compact` | see [Numbers](#numbers) | none | How the value and the limits are written. |

- **`radial`** reads the last row, as `stat` does.
- **`bar`** reads the latest row for each label, where the label is the first
  non-numeric column. Bars are sorted largest first, at most 50.
- A value outside its limits is drawn clamped to them. Its text is always the
  true value, formatted per `panel.format` and the number options.

```json
{
  "viz": "gauge",
  "format": "percent",
  "options": {
    "variant": "bar",
    "value": "cpu",
    "thresholds": [
      { "value": 0, "color": "success" },
      { "value": 70, "color": "warning" },
      { "value": 90, "color": "danger" }
    ]
  }
}
```

## `state-timeline`

Discrete states over time, one lane per entity
([#201](https://github.com/jbouder/holotable/issues/201)). Requires
`query.timeField`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `entity` | column name | first text column other than the state | One lane per value. |
| `state` | column name | last text column | The state of the entity from this row's time. |
| `states` | `[{ state, color }]`, at most 50 | none | A color per state. |
| `variant` | `"spans"` \| `"history"` | `"spans"` | Exact spans, or 40 fixed cells, each in the state that held at its middle. |

The query returns rows of time, entity and state, ordered by time. The spans
are built in the browser from those rows; the model still writes only SQL.

- A span runs from a row's time to the next row's time for the same entity.
  Consecutive rows in the same state are one span.
- Each lane's last span is still open. It ends at the end of the window the
  server resolved, which the stream sends with every `tick`, and never at the
  viewer's clock.
- At most 20 lanes are drawn; the chart says how many more there are.
- A state with no color gets one by name. `up`, `ok` and `healthy` are
  `success`; `down`, `error` and `failed` are `danger`; `warn` and `degraded`
  are `warning`. Any other state gets a fallback color worked out from its
  name, so the same state is always the same color.

## `status-grid`

One tile per entity, colored by threshold or by state
([#404](https://github.com/jbouder/holotable/issues/404)).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `entity` | column name | first text column other than the state | One tile per value. |
| `value` | column name | first numeric column | The number on the tile. |
| `state` | column name | none | A discrete state. When set, it colors the tile and is written on it, instead of the value's threshold. |
| `states` | `[{ state, color }]`, at most 50 | none | A color per state. |
| `sort` | `"label"` \| `"value"` \| `"none"` | `"label"` | By label (numbers in a label sort as numbers: `web-2` before `web-10`), largest value first, or the result's order. |
| `columns` | integer, 1 to 12 | as many as fit | Tiles per row. |
| `thresholds` | `[{ value, color }]`, ascending, at most 10 | none | A value takes the color of the last step at or below it. Below the first step, or with none, the tile is neutral. |
| `decimals`, `unit`, `compact` | see [Numbers](#numbers) | none | How the value is written. |

- Each entity's latest row is its tile, so a time series per host (bucketed,
  with `query.timeField`) reads as now, as a gauge's bars do. One row per
  entity works as well.
- A state with no color in `states` takes the state timeline's: `ok` is
  `success`, `down` is `danger`, and so on.
- The tile's text is always the foreground color over a tint of its color, so
  every tile meets WCAG AA in both themes; the value and state are written on
  it, so color is never the only signal.
- At most 200 tiles are drawn; the panel says how many more there are.
- With a [datum link](/guide/drilldown/), each tile is a link carrying its
  row, and its label is the series.

```json
{
  "viz": "status-grid",
  "format": "percent",
  "options": {
    "entity": "host",
    "value": "cpu",
    "thresholds": [
      { "value": 0, "color": "success" },
      { "value": 70, "color": "warning" },
      { "value": 85, "color": "danger" }
    ]
  }
}
```

## `text`

Markdown, and no query ([#202](https://github.com/jbouder/holotable/issues/202)).

| Option | Type | Meaning |
| --- | --- | --- |
| `content` | string, 1 to 10,000 characters | Required. |

A text panel carries no `query`, and the IR refuses one that does. It is never
executed, has no status badge, and offers no SQL or export. Every part of the
server that reads queries skips it: the poller, saving, re-pointing, export and
import, templates, and chat citations. Because a dashboard's sources decide
its workspace, a dashboard needs at least one panel that is not text.

The content is untrusted, and is rendered as a sanitized subset by
`src/lib/markdown.ts`:
- **Supported:** headings, paragraphs, bold and italic, inline and fenced code,
  lists, block quotes, rules, and pipe tables.
- **Rendered safely:** the Markdown is parsed into a tree and rendered as React
  elements, never as an HTML string, so raw HTML shows as text.
- **Links:** a link keeps its target only when it is an absolute `http(s):` or
  `mailto:` URL, and opens with `rel="noopener noreferrer"`. Anything else,
  including `javascript:`, shows as plain text.
- **Images:** never loaded; an image shows as its alt text.
