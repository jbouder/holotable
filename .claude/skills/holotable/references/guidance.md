# Choosing and laying out panels

Advice, not rules: a spec that ignores it still validates. It is what makes a
dashboard readable during an incident.

## Which kind answers which question

| The question | Kind | Query shape |
|---|---|---|
| How much right now? (requests, error rate, p95) | `stat` | One scalar; add `sparkline` with a per-bucket query for its recent history. |
| How is it changing? (rate, latency, saturation over time) | `line` | Bucketed time column + one or more numeric columns. |
| How much in total over time? (bytes, volume) | `area` | As `line`; `stacked: true` for parts of a whole. |
| Which are the biggest? (top routes, hosts, tenants) | `bar` (or `table`) | Label + value, `ORDER BY value DESC LIMIT 10`. |
| What share of the whole? (status classes, regions) | `pie` / `donut` | Label + value, a handful of categories. More than ~8 slices: use `bar`. |
| How close to a limit? (CPU %, disk, quota) | `gauge` | One value, `min`/`max` set; `variant: "bar"` for one bar per host. |
| What state was it in, and when? (up/down, deploys) | `state-timeline` | Raw time, entity, state, ordered by time. |
| What does it look like, not just its p95? (latency, sizes) | `histogram` | A bucket (lower bound) + a count, with a coarse time bucket; `cumulative` for a Prometheus `le`. |
| What did it say? (errors, audit entries, recent events) | `logs` | Raw time + message (+ level), newest first, `LIMIT 200`. |
| What is the whole made of, level by level? (disk, cost, traffic) | `treemap` | Path columns + a summable value; `variant: "sunburst"` for rings. |
| Which of these is unhealthy? (hosts, services, targets) | `status-grid` | One row per entity, a label + a value (or a state); thresholds color it. |
| Where is the load concentrated over time? | `heatmap` | Time bucket, a dimension, a count. |
| Do two measures move together? (size vs latency) | `scatter` | Two numeric columns, optionally a label. |
| I need the exact numbers | `table` | Rows; set `columns` labels and formats. |
| None of the above fits (a band and a rule, small multiples, a tick plot) | `vega` | Any result; a Vega-Lite spec over `{"name": "rows"}` in token colors. |
| What is this dashboard for? Who to page? | `text` | No query; Markdown in `options.content`. |

## Monitoring measures that read well

- **Rates and counts**: `count(*)` per bucket, or `count(*) FILTER (WHERE
  status >= 500)` beside it on the same line chart.
- **Error rate**: `100.0 * count(*) FILTER (WHERE status >= 500) /
  NULLIF(count(*), 0)` with `"format": "percent"`. `NULLIF` avoids a divide
  by zero on an empty window.
- **Latency**: percentiles, not averages. `percentile_cont(0.95) WITHIN GROUP
  (ORDER BY duration_ms)` with `"format": "ms"`. Show p50 and p95 together.
- **Saturation**: utilization against a bound, `gauge` 0–100 or a `line` with
  `yAxis: { min: 0, max: 100 }`.
- **Bucket size**: about 100–300 points across the default window. 1 minute
  for 1–6 h, 5 minutes for 24 h, 1 hour for 7 d. Prefer a rollup table (a
  continuous aggregate such as `…_1m`) when the catalog has one.

## The same measures in PromQL

For a Prometheus source (see `references/promql-rules.md`):

- **Counter or gauge.** A counter (`…_total`, `…_count`, `…_sum`, a histogram's
  `…_bucket`) only grows; draw its `rate(…[5m])` per second, or its
  `increase(…[1h])` for a count over a period. A gauge is a level; draw it as
  it is, or `avg_over_time`/`max_over_time` to smooth it. The guard hints when
  a counter is drawn raw or a gauge is rated.
- **Rate ranges.** `[5m]` is a good default: at least four scrape intervals,
  so a missed scrape does not break the line. The server picks the step; set
  `query.minStep` only to make a noisy line coarser.
- **Aggregate to what is drawn.** Each series is a line, a slice or a row, and
  a result is capped at 100 series. `sum by (route) (rate(…))` draws one line
  per route; `sum(rate(…))` draws one.
- **Error rate**: `100 * sum(rate(http_requests_total{code=~"5.."}[5m])) /
  sum(rate(http_requests_total[5m]))` with `"format": "percent"`.
- **Latency**: `histogram_quantile(0.95, sum by (le) (rate(…_bucket[5m])))`,
  keeping `le` in the `by`. Multiply a `…_seconds` histogram by 1000 for
  `"format": "ms"`.
- **`instant`**: set it for a stat, a gauge, a table, a pie or donut, a
  status grid, a histogram, a treemap, and a bar compared across a label; they
  draw one value per series. Leave it out for anything over time.
- **Not for PromQL**: `heatmap`, `scatter`, `state-timeline` and `logs` read
  row shapes a PromQL result does not have.

## Formats, units and thresholds

- Pick the `format` the raw value is in: `ms` for milliseconds, `bytes` for
  bytes, `percent` for an already-0–100 value. Convert in SQL, not in `unit`.
- `unit` is a label (`"req/s"`, `"hosts"`), not a conversion.
- `compact: true` for large counts on a stat.
- Thresholds read green → amber → red: `[{value: 0, color: "success"},
  {value: 1, color: "warning"}, {value: 5, color: "danger"}]` for an error
  rate. Ask the author for their SLO rather than inventing numbers, and say
  when a threshold is a placeholder.

## Layout

- The grid is 12 columns. Defaults: two panels side by side, `w: 6`, `h: 4`.
- Top row: what an on-call reader needs first, as `stat` tiles (`w: 3`, `h: 3`,
  four across): traffic, errors, latency, saturation.
- Then the trends that explain them (`line`, `w: 6`), then the breakdowns
  (`bar`, `table`, `pie`), then detail (`heatmap`, `state-timeline`, often
  `w: 12`).
- A `text` panel at the top (`w: 12`, `h: 2`) says what the dashboard is for
  and links the runbook.
- No overlaps, nothing past column 12, no gaps that leave a ragged right edge.

## Titles and descriptions

- Title: what is measured, in a few words ("p95 latency", "Errors per minute").
  No units in the title when `format` or `unit` already carries them.
- Description: one sentence on what the query computes, its grouping and unit.
  Never a value or a trend; the spec is written before anyone has seen the
  data.

## Variables

Add one only when the dashboard should switch between values of a dimension
(per host, per region, per service). A `query` variable lists values from the
catalog (`SELECT DISTINCT host FROM … ORDER BY 1`); an `enum` lists them
literally. Use `multi: true` with `= ANY(:name)` when comparing several makes
sense.

## Per-panel window and cadence

Give a panel its own `timeRange` or `refreshIntervalMs` only when it must
differ from the rest, such as a "last 24 hours" table refreshed every 5
minutes on a 1-hour dashboard.

## Links

A panel's `links` say where it leads (see `ir.md` for the fields). Write one
only when there is a natural next step:

- **A breakdown to the dashboard about one of its items.** A panel grouped by
  instance links to a dashboard that declares an `instance` variable, setting
  it from the clicked row: `{ "column": "instance" }`. Clicking a row, bar or
  slice then opens that dashboard with the instance picked.
- **A self link to filter in place.** When this dashboard declares a variable
  and a panel breaks the data down by it, a link with no `dashboard` that sets
  the variable from the clicked series or column turns a click into a filter.

What a link may target:

- `dashboard` is the id of a dashboard in the same workspace, copied from
  wherever you were given it. Never invent an id and never write a URL; when
  you do not know the target's id, leave the link out and say so.
- `set` names only variables the target declares. A name it does not declare
  is ignored on arrival.
- A `column` pick must be an output column of the panel's own SQL.

Do not give every panel a link. One or two that answer "and then what?" are
worth more than a menu on every card.

```json
{
  "id": "by-instance",
  "title": "CPU by instance",
  "viz": "bar",
  "query": {
    "sourceId": "ts-metrics",
    "sql": "SELECT instance, avg(cpu_pct) AS cpu FROM system_metrics GROUP BY instance ORDER BY cpu DESC"
  },
  "links": [
    {
      "title": "Instance detail",
      "dashboard": "3f6c2a1e-8b4d-4c7a-9e21-5d0b7a6f4c13",
      "set": { "instance": { "column": "instance" } }
    },
    { "title": "Filter to this instance", "set": { "instance": { "column": "instance" } } }
  ],
  "layout": { "x": 0, "y": 0, "w": 6, "h": 4 }
}
```
