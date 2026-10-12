# The LogQL rules

A panel on a Loki source (kind `loki`) is written in LogQL, in `query.logql`,
never `sql`, `promql` or `timeField`. Every expression is untrusted and passes
the guard in `src/lib/logql/safety.ts` before it runs, against the stream
label allowlist of the source its `sourceId` names. It is parsed with Loki's
own grammar, so these rules are about the parse tree, not the spelling.
`examples/logql.json` has accepted and rejected expressions per rule, each
checked by a test against `examples/loki-catalog.json`; the error text below
is what the guard returns.

## Two kinds of query

- A **log query** is a stream selector and then its pipeline: line filters
  (`|=`, `!=`, `|~`, `!~`), parsers (`| json`, `| logfmt`, `| pattern`,
  `| regexp`, `| unpack`), label filters (`| status >= 500`), `line_format`,
  `label_format`, `keep`, `drop`, `decolorize`. It answers lines.
- A **metric query** wraps a log query's range in a range function
  (`count_over_time`, `rate`, `bytes_over_time`, `sum_over_time` and the other
  `*_over_time` functions over an `unwrap`ped field) and, usually, an
  aggregation (`sum`, `avg`, `min`, `max`, `count`, `topk`, `bottomk`, `sort`,
  `stddev`, `stdvar`) with `by` or `without`. It answers series, in exactly
  the shape a PromQL result has.

## What is refused, and the error you will see

| Rule | Error contains |
|---|---|
| A selector with no `=` matcher on a listed label: regex or `!=` matchers alone, or only labels the source does not list | `every stream selector needs an "=" matcher with a value on a label this source lists` |
| An empty selector `{}`, an unclosed string, or anything outside Loki's grammar | `LogQL does not parse at character` |
| Comments, `#` | `comments are not allowed` |
| A log query beside an operator, `{app="api"} / 2` | `a log query cannot be an operand of a binary operator` |
| A range or offset longer than the server allows (7 days by default) | `is longer than the 7d this server allows` |
| A negative offset | `a negative offset reads past the end of the window` |
| A variable inside a regex or pattern: an `=~` or `!~` matcher, a `\|~` or `!~` line filter, a `pattern` or `regexp` parser | `cannot be used inside a regex or a pattern` |
| A variable as any other string, such as a `line_format` template | `may appear only as a matcher's whole value` |
| A variable as a label name or a field | `a variable may appear only as a value, not as a label name or a field` |
| A variable the dashboard does not declare | `variable :app is not declared on this dashboard` |

Stages, range functions and aggregations are an allowlist: one the grammar
gains later is refused until someone lists it. More than 32 stream selectors,
nesting deeper than 128 levels, or more than 8,000 characters is refused too.

A matcher on a label the catalog does not list, beside an anchored one, is
not refused; it comes back as a hint (`no label "pod" in this source's
catalog`), because it probably matches nothing.

## What the server does instead, so you must not

- **The time window.** There is no `timeField` and no absolute time in
  LogQL. The server resolves the dashboard's (or the panel's) window and asks
  Loki itself: `start`, `end` and `direction` for a log query, `start`, `end`
  and `step` for a metric query (picked as PromQL's is, raised to
  `query.minStep`), or one `time` for an instant query. A `[5m]` inside
  `count_over_time` is a lookback, not a window, and is fine; an `offset` is
  capped at the server's range.
- **How many lines.** Never write a limit. A logs panel sets
  `options.limit` (say 200); the server sends the smaller of it and its own
  cap, and newest lines come first. A cut is badged on the panel.
- **`instant`.** Only on a metric query, for a kind that draws one value per
  series: a stat, a gauge, a table, a pie or donut, a status grid, a
  histogram or a treemap. A log query runs over the window and is never
  instant: `a log query runs over the dashboard's range; it cannot be an
  instant query`.
- **Row-level filters.** A source can carry a tenant label. The server adds
  a matcher for the viewer's tenant to every selector before it runs, so
  write the expression as if Loki held only the viewer's streams.

## Which panel takes which query

- A **`logs` panel is a log query**: `{app="api"} |= "error"`, with
  `options.limit` for how many lines. Its rows are each line's `time`, its
  text as `message`, then its labels as columns, so leave `options.message`
  out. When the catalog lists a level label, or you parse a level field out
  of the line, name it in `options.level`.
- **Every other kind is a metric query.** It answers in PromQL's shape (a
  `time` column and one column per series, or for an instant query one row
  per series, a column per label, then `value`), so the kind's "With
  PromQL:" line in `panel-kinds.md` holds for it, written in LogQL:
  `sum by (route) (count_over_time({app="api"} | json [5m]))`.

## Variables in LogQL

- A variable is a matcher's whole value with `=` or `!=`, quoted, in a
  selector or a label filter after a parser: `{env=":env"}`,
  `| level=":level"`. Or the whole string of a `|=` or `!=` line filter:
  `|= ":needle"`. It is bound as a string the server escapes, never spliced
  as text.
- Never in a regex or a pattern, never as a label name, and never a `multi`
  variable.
- A variable for a Loki source is usually label values: `"query":
  { "sourceId": "…", "label": "app" }`, optionally narrowed by one stream
  selector, `"match": "{env=\"prod\"}"`, with nothing around it.

## Writing against a label catalog

The catalog is the allowlist: `labels`, each with a `name` and some of the
`values` seen. Every selector anchors on at least one of them with `=` and a
value. Fields inside a line are not in the catalog; parse them with `| json`
or `| logfmt` before you filter or group on them.
