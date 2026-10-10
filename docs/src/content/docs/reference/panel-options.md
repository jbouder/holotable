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

Taken by `line`, `area`, `bar`, `stat`, `pie`, `donut`, `gauge`,
`status-grid`, `histogram` and `treemap`, and by each
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

Taken by `line`, `area`, `bar`, `stat`, `gauge`, `status-grid` and
`histogram`: `[{ value, color }]`,
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

## `histogram`

A value distribution, one bar per bucket
([#404](https://github.com/jbouder/holotable/issues/404)).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `bucket` | column name | `le` when `cumulative` and present, else the first column other than the time field | The bucket: its lower bound, or a label. |
| `count` | column name | first numeric column other than the bucket | Summed per bucket across the rows. |
| `cumulative` | boolean | `false` | Each bucket is an upper bound with a cumulative count, as a Prometheus classic histogram's `le` is. Each bar is the difference from the bound below it, and `+Inf` is last. |
| `log` | boolean | `false` | A logarithmic count axis, for a long tail. An empty bucket is left off it. |
| `thresholds` | `[{ value, color }]`, ascending, at most 10 | none | Each bar takes the color of its bucket's lower bound: an SLO, drawn as color. Below the first step, or with none, it is `info`. |
| `decimals`, `unit`, `compact` | see [Numbers](#numbers) | none | How the bucket bounds are written, with `panel.format`. The counts are plain numbers. |

- Rows are summed per bucket, so a query that also groups by a time bucket
  (to take the panel's window through `query.timeField`) draws the
  distribution across the whole window. Keep that time bucket coarse
  (`time_bucket('5 minutes', ts)`): time buckets times value buckets is the
  row count, and the server caps it.
- Numeric buckets are ordered by value. Text buckets keep the result's order.
- With `cumulative`, a bar's label is its range (`0.1 s–0.5 s`), the first is
  `≤ 0.05 s` and the last is `> 0.5 s`. A count that falls between two bounds
  is a counter reset inside the window, and is drawn as zero.
- At most 200 bars are drawn.
- A click on a bar carries its bucket and summed count to a
  [datum link](/guide/drilldown/).

```json
{
  "viz": "histogram",
  "format": "ms",
  "query": {
    "sourceId": "ts-metrics",
    "timeField": "period",
    "sql": "SELECT time_bucket('5 minutes', ts) AS period, floor(duration_ms / 50) * 50 AS bucket, count(*) AS requests FROM http_requests GROUP BY period, bucket ORDER BY period, bucket"
  },
  "options": {
    "decimals": 0,
    "thresholds": [
      { "value": 0, "color": "success" },
      { "value": 300, "color": "warning" },
      { "value": 1000, "color": "danger" }
    ]
  }
}
```

With PromQL, an instant query over a classic histogram's buckets reads in
`cumulative` mode: `sum by (le) (increase(http_request_duration_seconds_bucket[1h]))`.

## `logs`

Log lines, newest first
([#404](https://github.com/jbouder/holotable/issues/404)). Requires
`query.timeField`.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `message` | column name | the longest text column | The line's text. |
| `level` | column name | a column named `level` or `severity` | A level, written on each line and coloring its edge. |
| `levels` | `[{ state, color }]`, at most 20 | none | A color per level. |
| `wrap` | boolean | `true` | Wrap long lines, or cut them at the panel's edge. |
| `order` | `"newest"` \| `"oldest"` | `"newest"` | Which end of the window comes first. |
| `showTime` | boolean | `true` | Write each line's time, on the viewer's clock. |

- The query returns raw rows: the time column (not bucketed), the message, a
  level if there is one, and anything else worth reading. Order by time
  descending and `LIMIT` it; at most 500 lines are drawn.
- A level without a color in `levels` takes the usual one, in any case:
  `error`, `fatal` and `critical` are `danger`, `warn` is `warning`, `info` is
  `info`, `debug` and `trace` are `neutral`. Any other level gets a color
  worked out from its name.
- Every column that is not the time, the message or the level is shown, as
  name and value, when a line is expanded.
- The text is always the foreground color. The level's color is a stripe on
  the line's edge, and the level is written, so color is never the only
  signal.
- When a poll adds lines above a reader who has scrolled down, the list keeps
  the line they were reading where it was.
- To filter by level, put it in the SQL with a
  [variable](/guide/variables/): `WHERE level = ANY(:level)`.

## `treemap`

What a whole is made of, level by level
([#404](https://github.com/jbouder/holotable/issues/404)).

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `path` | 1 to 5 column names | every text column other than the time field | The levels, top first. |
| `value` | column name | first numeric column | The size of each leaf. |
| `variant` | `"treemap"` \| `"sunburst"` | `"treemap"` | Nested rectangles, or rings from the center out. |
| `decimals`, `unit`, `compact` | see [Numbers](#numbers) | none | How a value is written in labels and tooltips, with `panel.format`. |

- Each row is a leaf at the end of its path. Rows with the same path are
  summed, and a parent is the sum of its children, so a query returns
  counts and totals rather than averages. A coarse time bucket as
  `query.timeField` (`time_bucket('5 minutes', ts)`) applies the window and
  sums correctly.
- A zero, negative or missing value is not drawn. At most 500 leaves are, the
  largest.
- Every node takes its top-level branch's chart color. Its label is black or
  white, whichever meets WCAG AA on that color.
- A click on a node follows a [datum link](/guide/drilldown/), carrying the
  node's path columns and its summed value; it never zooms.

```json
{
  "viz": "treemap",
  "format": "bytes",
  "query": {
    "sourceId": "ts-system",
    "timeField": "period",
    "sql": "SELECT time_bucket('5 minutes', ts) AS period, region, host, sum(net_in_bytes) AS bytes FROM system_metrics GROUP BY period, region, host ORDER BY period"
  },
  "options": { "path": ["region", "host"], "value": "bytes" }
}
```

## `vega`

A custom visual: a Vega-Lite spec over the panel's rows
([#405](https://github.com/jbouder/holotable/issues/405)). For a view no other
kind draws; [Custom visuals](/architecture/custom-visuals/) has the why.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `spec` | Vega-Lite JSON, at most 32 KB | required | The view, encoding the query's columns by name. |

The spec is checked wherever the panel is parsed, and compiled wherever the
dashboard is saved:

- Its `data` is exactly `{ "name": "rows" }`, at the top and anywhere else one
  appears. The rows are the panel's query result, the only data it sees.
- Refused anywhere in it: `url`, `href`, an `image` mark, `datasets`, inline
  `values`, `config`, `usermeta`, a `scheme`, a `projection`, and a parameter
  bound to an `element`.
- Every color is a token name (`success`, `warning`, `danger`, `info`,
  `neutral`, `orange`, `purple`, `teal`), a chart color by index
  (`palette-0` to `palette-5`) or `transparent`. They are painted as the other
  kinds paint them.
- Marks: `arc`, `area`, `bar`, `boxplot`, `circle`, `errorband`, `errorbar`,
  `line`, `point`, `rect`, `rule`, `square`, `text`, `tick`, `trail`. Field
  types: `quantitative`, `temporal`, `ordinal`, `nominal`.
- A spec that passes those checks but does not compile is refused at save,
  with Vega-Lite's own message.

A single view (one mark, or layers) takes the panel's size. A faceted,
repeated or concatenated one draws at the sizes its spec gives, scaled down to
fit the panel when it is larger. The axes, grid
and legend use the same colors as the other charts. Each poll replaces the
rows in the same view. The panel exports as a PNG, and its rows are in a
visually hidden table for a screen reader. A click does not follow a
[datum link](/guide/drilldown/); the panel menu's links work as for any
panel.

```json
{
  "viz": "vega",
  "options": {
    "spec": {
      "data": { "name": "rows" },
      "layer": [
        {
          "mark": "area",
          "encoding": {
            "x": { "field": "minute", "type": "temporal" },
            "y": { "field": "low", "type": "quantitative" },
            "y2": { "field": "high" },
            "color": { "value": "palette-0" },
            "opacity": { "value": 0.25 }
          }
        },
        {
          "mark": "line",
          "encoding": {
            "x": { "field": "minute", "type": "temporal" },
            "y": { "field": "mean", "type": "quantitative" },
            "color": { "value": "palette-0" }
          }
        },
        { "mark": "rule", "encoding": { "y": { "datum": 85 }, "color": { "value": "danger" } } }
      ]
    }
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
