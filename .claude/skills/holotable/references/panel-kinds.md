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

With PromQL: a range query (no `instant`); each series is a line, so aggregate to a few, `sum by (route) (rate(http_requests_total[5m]))`.

### `area`

A filled time series, for a volume or a total over time. Same query shape and
options as `line`.

With PromQL: a range query drawn filled, for a volume or a total over time.

### `bar`

Values per time bucket (with `query.timeField`), or compared across a
categorical dimension (one label column plus numeric columns, no
`query.timeField`). Same options as `line`.

With PromQL: a range query drawn as bars per step, or an instant query (`"instant": true`) compared across one label, `sum by (code) (increase(http_requests_total[1h]))`.

### `scatter`

The relationship between two numeric dimensions. The first numeric column is
the x-axis, the second the y-axis; a label column may follow. No options.

With PromQL: not for a Prometheus source; a PromQL result is a time and one column per series.

### `stat`

A single scalar: the last row's first numeric column, or `options.value`.
Usually omits `query.timeField`. With `options.sparkline: true` the query
returns one row per time bucket (and then sets `query.timeField`), and the
history is drawn behind the latest value.

Options: number, thresholds, `value` (the column shown), `sparkline`.

With PromQL: an instant query returning one series, `sum(rate(http_requests_total[5m]))`.

### `table`

Rows and columns to read, rather than a shape to see. No `query.timeField`
unless the rows are per time bucket.

Options: `columns` (up to 50 entries `{ name, label, hidden, format, decimals,
unit, compact, align: "left"|"center"|"right", width: 40–800 }`; listed columns
come first, in order, and each name once), `sort` (`{ column, order:
"asc"|"desc" }`).

With PromQL: an instant query; one row per series, a column per label, then `value`.

### `heatmap`

Two dimensions against an intensity: exactly three columns, x (often a time
bucket, then set as `query.timeField`), y, and value. No options.

With PromQL: not for a Prometheus source; a PromQL result is a time and one column per series.

### `pie`

A proportional breakdown of a small set of categories (up to about 8): one
label column and one numeric value column. Omit `query.timeField`; it is not a
time series.

Options: number, legend.

With PromQL: an instant query aggregated by one label, each series a slice, `sum by (route) (increase(http_requests_total[1h]))`.

### `donut`

The same as `pie`, drawn as a ring. Same query shape and options.

With PromQL: as `pie`.

### `gauge`

One value with natural bounds (a percentage, utilization, a quota left) shown
against `options.min` and `options.max`. The latest row is shown; with
`options.variant: "bar"` there is one bar per row of a label column (one per
host, say). Use `stat` instead for an unbounded count.

Options: number, thresholds, `variant` (`"radial"`, the default, or `"bar"`),
`value` (the column shown), `min` and `max` (numbers, or the name of a result
column holding the bound; default 0 and 100; `min` below `max`).

With PromQL: an instant query; with `variant: "bar"`, one bar per series, `sum by (instance) (…)`.

### `state-timeline`

Discrete states over time (up/down, deploy phase, job status), one lane per
entity. A span runs from a row's time to the next row's for the same entity.
Return the raw time column, an entity column and a state column, ordered by
time, without bucketing. Requires `query.timeField`.

Options: `entity` (the lane column; default the first text column other than
the state), `state` (default the last text column), `states` (up to 50
`{ state, color }` pairs, each state once), `variant` (`"spans"`, the
default, or `"history"`: fixed cells, each showing the state at its middle).

With PromQL: not for a Prometheus source; it needs an entity column and a state column per row. Draw the state value as a `line` instead.

### `status-grid`

Which of many things is healthy, at a glance: one tile per entity (a host, a
service, a pod) showing its latest value, colored by `thresholds` or by a
discrete state. Return one row per entity, or a series per entity: the latest
row of each is shown. Use `gauge` with `variant: "bar"` instead to rank values
against a limit.

Options: number, thresholds, `entity` (the tile's label; default the first
text column other than the state), `value` (default the first numeric
column), `state` (a state column; when set it colors the tile through
`states` and is written on it, instead of the value's threshold), `states`
(up to 50 `{ state, color }` pairs, each state once), `sort` (`"label"`, the
default, `"value"`, largest first, or `"none"`), `columns` (1–12 tiles per
row; default as many as fit). At most 200 tiles are drawn.

With PromQL: an instant query, one tile per series, `max by (instance) (up)` with `entity: "instance"` and thresholds `[{0, danger}, {1, success}]`.

### `histogram`

How a value is distributed (latency, payload size, queue depth), where a
percentile line hides the shape. Return a bucket column, its lower bound
(`floor(duration_ms / 50) * 50 AS bucket`), and a count. Add a coarse time
bucket as `query.timeField` (`time_bucket('5 minutes', ts) AS period`) so the
window applies: the counts are summed per bucket across the rows, and a fine
time bucket times many value buckets runs into the row cap. Numeric buckets
are ordered by value; text buckets keep the result's order.

Options: number (how the bucket bounds are written; the counts are plain
numbers), thresholds (each bar takes the color of its bucket's lower bound:
an SLO drawn as color), `bucket` and `count` (the columns; default the first
column other than the time field, and the first numeric column after it),
`cumulative` (`true` when each bucket is an upper bound with a cumulative
count; each bar is then the difference from the bound below, `+Inf` last),
`log` (`true` for a logarithmic count axis, for a long tail).

With PromQL: an instant query over a classic histogram's buckets, `sum by (le) (increase(http_request_duration_seconds_bucket[1h]))`, with `cumulative: true` and `bucket: "le"`.

### `logs`

Raw events to read: log lines, audit entries, recent errors. Return the raw
time column (no bucketing) as `query.timeField`, a message column and,
optionally, a level column, `ORDER BY ts DESC LIMIT 200`. Lines are shown
newest first; every other column is shown when a line is expanded.
Requires `query.timeField`. At most 500 lines are drawn. Filter by level in the SQL,
with a variable for a picker (`WHERE level = ANY(:level)`).

Options: `message` (default the longest text column), `level` (the level
column; default one named `level` or `severity`), `levels` (up to 20 `{ state, color }` pairs; without one, `error` and
`fatal` are `danger`, `warn` is `warning`, `info` is `info`, `debug` is
`neutral`), `wrap` (default `true`), `order` (`"newest"`, the default, or
`"oldest"`), `showTime` (default `true`).

With PromQL: not for a Prometheus source; a PromQL result has no lines. Use `table` for an instant query's series.

### `text`

Prose for the reader: a heading, what the dashboard is for, a runbook link.
Runs no query. Omit `query`, `timeRange` and `refreshIntervalMs` entirely.

Options: `content` (required; Markdown, 1–10,000 chars). Rendered as a
sanitized subset: headings, emphasis, lists, code, tables and
http(s)/mailto links; raw HTML is shown as text. Describe intent only, never a
number or a trend.
