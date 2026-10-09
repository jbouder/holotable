# The PromQL rules

A panel on a Prometheus source (kind `prometheus`) is written in PromQL, in
`query.promql`, never SQL. Every expression (panel or variable selector) is
untrusted and passes the guard in `src/lib/promql/safety.ts` before it runs,
against the metric allowlist of the source its `sourceId` names. It is parsed
with the Prometheus project's own grammar, so these rules are about the parse
tree, not the spelling. `examples/promql.json` has accepted and rejected
expressions per rule, each checked by a test against
`examples/prometheus-catalog.json`; the error text below is what the guard
returns.

## What is refused, and the error you will see

| Rule | Error contains |
|---|---|
| A selector of a metric the source does not list | `metric "node_load1" is not in this source's catalog` |
| A selector with no metric name: `{job="api"}` | `every selector must name a metric` |
| `__name__` matched by a pattern or a negation | `__name__ may only be matched with "="` |
| The `@` modifier, at a timestamp, `start()` or `end()` | `the @ modifier is not allowed: the server owns the time of every query` |
| Comments, `#` | `comments are not allowed` |
| A function outside the stable set, such as `info()` or an experimental one | `function info() is not allowed` |
| A range, subquery range or offset longer than the server allows (7 days by default) | `is longer than the 7d this server allows` |
| A subquery that evaluates more than 11,000 points | `evaluates more than 11000 points` |
| A subquery step under one second | `a subquery step must be at least 1s` |
| A variable as a metric name | `a variable may appear only as a label matcher's value, not as a metric name` |
| A variable as any other string, such as an argument of `label_replace` | `may appear only as a label matcher's whole value` |
| A variable the dashboard does not declare | `variable :instance is not declared on this dashboard` |
| An expression that does not parse, an unclosed string included | `PromQL does not parse at character` |
| More than 32 selectors, nesting deeper than 64, or longer than 8,000 characters | `the query has more than 32 selectors` |

Everything else in PromQL is fine: arithmetic and comparison, `and`, `or`,
`unless`, `on`/`ignoring`, `group_left`/`group_right`, the aggregations
(`sum`, `avg`, `min`, `max`, `count`, `count_values`, `group`, `stddev`,
`stdvar`, `quantile`, `topk`, `bottomk`) with `by` and `without`, range
vectors, subqueries and `offset`.

## What the guard notices without refusing

A validation answers with hints alongside `ok`. They are worth fixing:

- `http_requests_total has no label "host" in the catalog`: the label is not
  one the allowlist lists for that metric, so the matcher probably matches
  nothing.
- `rate() over up, a gauge: it is meant for counters`: `rate`, `irate` and
  `increase` are for counters. Plot a gauge as it is, or with `avg_over_time`.
- `http_requests_total is a counter, which only grows; plot
  rate(http_requests_total[5m]) or increase(...)`: a raw counter is a rising
  line that says nothing.

## What the server does instead, so you must not

- **The time window.** There is no `timeField`. The server resolves the
  dashboard's (or the panel's) window, picks the step and asks the endpoint
  itself: a range query with `start`, `end` and `step`, or an instant query
  at the window's end. The step is the
  window divided by 1,000 points, never under 15 seconds, and raised to
  `query.minStep` when the panel sets one. Never write an `@` or a time of
  your own; a `[5m]` inside `rate()` is a lookback, not a window, and is fine.
- **`instant`.** Set `"instant": true` for a kind that draws one value per
  series: a stat, a gauge, a table, a pie or donut, and a bar compared across
  a label. Leave it out for a line, an area, or bars over time.
- **The result's shape.** A range query answers a `time` column and one
  numeric column per series, named the way the Prometheus UI names a legend
  entry: `{route="/api"}`, or `metric{…}` when the series have different
  names. An instant query answers one row per series, one column per label,
  then `value`. So aggregate to the series you want drawn: `sum by (route)
  (…)` makes one line per route.
- **Limits.** At most 100 series and 1,000 points per series; results are
  capped in bytes and time. Aggregate rather than drawing every instance.
- **Row-level filters.** A source can carry a tenant label. The server adds a
  matcher for the viewer's tenant to every selector before it runs, so write
  the expression as if the endpoint held only the viewer's series.

## Variables in PromQL

- A variable is a label matcher's whole value, quoted: `{host=":host"}`. It is
  bound as a string the server escapes, never spliced as text. Inside a longer
  string, `{host="web-:host"}`, it is not a variable at all, just text.
- A `multi` variable matches with a regex operator: `{host=~":host"}`. The
  server writes the values as an escaped alternation.
- A variable for a Prometheus source is usually label values: `"query":
  { "sourceId": "…", "label": "instance" }`, optionally narrowed by a series
  selector, `"match": "up{job=\"node\"}"`. The selector names a listed metric
  and is one selector, nothing around it.

## Writing against a metric catalog

The catalog is the allowlist: `metrics`, each with a `name`, a `type`
(`counter`, `gauge`, `histogram`, `summary` or `unknown`), sometimes a `help`
line, and the `labels` its series carry. A histogram is listed as its series:
`…_bucket` (with `le`), `…_count` and `…_sum`. Use only listed metrics, and
only their listed labels in matchers and `by` clauses.
