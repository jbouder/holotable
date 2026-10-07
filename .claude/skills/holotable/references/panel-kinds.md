# Panel kinds

`panel.viz` is one of these, and nothing else. The list and its order are the
panel registry's (`src/lib/panels/registry.ts`); a test holds this page to it.
Each entry says what the kind is for, the result shape its query must return,
and the `options` it takes. Every option is optional. An option a kind does not
list is refused, and a kind with no options listed takes none.

Shared option fragments, used below:

- **number**: `decimals` (0–6), `unit` (1–16 chars, e.g. `"req/s"`; a unit
  starting with `/` or `%` is attached with no space), `compact` (`true` for
  `1.2K`; ignored by `bytes`).
- **legend**: `legend`: `"top"` (default), `"bottom"`, `"right"` or `"none"`.
- **thresholds**: up to 10 `{ "value": number, "color": token }` steps in
  strictly ascending order of `value`. A value takes the color of the last step
  at or below it; below the first step it keeps the kind's default color.

### `line`

A numeric trend over time, one line per numeric column. Requires a time
bucket: `time_bucket('1 minute', ts) AS minute` with `query.timeField:
"minute"`, ordered by it ascending.

Options: number, legend, thresholds, `yAxis` (`{ min, max, log, label }`;
`min` below `max`, and a `log` axis starts above zero), `stacked` (`true`).

### `area`

A filled time series, for a volume or a total over time. Same query shape and
options as `line`.

### `bar`

Values per time bucket (with `query.timeField`), or compared across a
categorical dimension (one label column plus numeric columns, no
`query.timeField`). Same options as `line`.

### `scatter`

The relationship between two numeric dimensions. The first numeric column is
the x-axis, the second the y-axis; a label column may follow. No options.

### `stat`

A single scalar: the last row's first numeric column, or `options.value`.
Usually omits `query.timeField`. With `options.sparkline: true` the query
returns one row per time bucket (and then sets `query.timeField`), and the
history is drawn behind the latest value.

Options: number, thresholds, `value` (the column shown), `sparkline`.

### `table`

Rows and columns to read, rather than a shape to see. No `query.timeField`
unless the rows are per time bucket.

Options: `columns` (up to 50 entries `{ name, label, hidden, format, decimals,
unit, compact, align: "left"|"center"|"right", width: 40–800 }`; listed columns
come first, in order, and each name once), `sort` (`{ column, order:
"asc"|"desc" }`).

### `heatmap`

Two dimensions against an intensity: exactly three columns, x (often a time
bucket, then set as `query.timeField`), y, and value. No options.

### `pie`

A proportional breakdown of a small set of categories (up to about 8): one
label column and one numeric value column. Omit `query.timeField`; it is not a
time series.

Options: number, legend.

### `donut`

The same as `pie`, drawn as a ring. Same query shape and options.

### `gauge`

One value with natural bounds (a percentage, utilization, a quota left) shown
against `options.min` and `options.max`. The latest row is shown; with
`options.variant: "bar"` there is one bar per row of a label column (one per
host, say). Use `stat` instead for an unbounded count.

Options: number, thresholds, `variant` (`"radial"`, the default, or `"bar"`),
`value` (the column shown), `min` and `max` (numbers, or the name of a result
column holding the bound; default 0 and 100; `min` below `max`).

### `state-timeline`

Discrete states over time (up/down, deploy phase, job status), one lane per
entity. A span runs from a row's time to the next row's for the same entity.
Return the raw time column, an entity column and a state column, ordered by
time, without bucketing. Requires `query.timeField`.

Options: `entity` (the lane column; default the first text column other than
the state), `state` (default the last text column), `states` (up to 50
`{ state, color }` pairs, each state once), `variant` (`"spans"`, the
default, or `"history"`: fixed cells, each showing the state at its middle).

### `text`

Prose for the reader: a heading, what the dashboard is for, a runbook link.
Runs no query. Omit `query`, `timeRange` and `refreshIntervalMs` entirely.

Options: `content` (required; Markdown, 1–10,000 chars). Rendered as a
sanitized subset: headings, emphasis, lists, code, tables and
http(s)/mailto links; raw HTML is shown as text. Describe intent only, never a
number or a trend.
