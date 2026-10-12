---
title: Loki sources
description: A Loki-compatible endpoint as a data source. Its catalog is stream labels, its panels are LogQL, and the server still owns the window.
---

A source has a **kind** ([Source kinds](/architecture/data-model/#source-kinds)).
A TimescaleDB/PostgreSQL source answers SQL, a Prometheus source answers
PromQL, and a **Loki** source answers LogQL: Grafana Loki, Grafana Cloud Logs,
or anything that answers `/loki/api/v1/*`. Everything the app guarantees about
a SQL or PromQL panel holds for a LogQL one. The model writes a spec and never
data. The query is untrusted and guarded. The server owns the time window. A
spec names its source by an opaque id and nothing else.

LogQL is PromQL with a log pipeline in front. A Loki source is the
[Prometheus kind](/concepts/prometheus-sources/)'s twin: the same URL rules,
the same auth modes and secret references, the same step arithmetic. What it
adds is a second result shape, lines, which is what the `logs` panel kind was
built to read.

## The source

A Loki source's config is its endpoint and its **label allowlist**:

```json
{
  "kind": "loki",
  "url": "https://loki.example.com",
  "auth": "bearer",
  "labels": [
    { "name": "app", "values": ["api", "web", "worker"] },
    { "name": "env", "values": ["prod", "staging"] },
    { "name": "tenant" }
  ],
  "rowFilter": { "label": "tenant", "claim": "tenant" }
}
```

- **`url`** is the base the Loki HTTP API answers under; the server adds
  `/loki/api/v1/…`. A source admin chooses it, so it is held to the rules a
  model base URL is: public `https` unless the operator's
  `SOURCE_URL_ALLOWLIST` names the host, no credentials in it, and no
  redirects followed. See [Loki endpoints](/admin/loki/).
- **`auth`** is `none`, `bearer` or `basic`. The credential is never in the
  config. A source with `bearer` or `basic` names a
  [`secret_ref`](/admin/secret-references/#prometheus-sources) and the server
  resolves `<REF>_TOKEN` or `<REF>_USERNAME`/`<REF>_PASSWORD` when it connects,
  exactly as for a Prometheus source. `none` is for an in-cluster endpoint and
  names no ref.
- **`labels`** is the allowlist, the LogQL counterpart of a SQL source's
  tables and a Prometheus source's metrics: at most 200 stream labels, each
  with up to 100 `values` discovery found. The values are hints for the author
  and the model, never compared by the guard. Every stream selector must be
  anchored on one of these labels.
- **`rowFilter`** is optional. It names a tenant label and the identity claim
  whose value the viewer's queries are narrowed to. See
  [row-level filters](/admin/row-level-filters/#on-a-prometheus-source); a
  Loki source's works the same way.

The **Data sources** page registers one through the same dialog as a
database, with **Loki (LogQL)** as the kind. **Discover labels** asks the
endpoint for the stream labels it holds over the discovery window and offers
them in a searchable list; ticking one asks for its values. A real Loki has
few labels and many values, so the values are shown beside each ticked label.
**Test** asks `/ready`, makes one `labels` call with the source's credential,
reads the build, and checks each allowlisted label still has streams. Loki has
no write surface a query credential reaches, so there is none to report.
**Refresh** re-reads the values without adding or dropping a label: the
allowlist stays the author's.

## A LogQL panel

A panel on a Loki source carries `query.logql`, and no `timeField`:

```json
{
  "id": "errors",
  "title": "API errors",
  "viz": "logs",
  "query": {
    "sourceId": "loki-prod",
    "logql": "{app=\"api\", env=\":env\"} |= \"error\" | json | level=\"error\""
  },
  "options": { "level": "level", "limit": 200 },
  "layout": { "x": 0, "y": 0, "w": 12, "h": 5 }
}
```

A panel's language is its source's. A LogQL panel pointed at a SQL or
Prometheus source is refused by name ("source answers PromQL; this query is
LogQL") wherever it would run, and so is the reverse. The editor never saves
one: moving a panel to a source of another kind restarts its query from that
source's starter.

## Log queries and metric queries

The parse tree says which a query is, and the result's shape follows:

- **A log query** is a stream selector and its pipeline:
  `{app="api"} |= "error" | json | level="error"`. It answers **lines**, one
  row each: `time`, `message` (the line, or what `line_format` made of it),
  then one column per stream label and per label the pipeline parsed. That is
  the `logs` panel kind's shape: name a level label or parsed field in
  `options.level` and leave `options.message` out. A log query is never
  `instant`; Loki runs one only over a range.
- **A metric query** wraps a log range in a range function:
  `sum by (route) (rate({app="api"} | json | level="error" [5m]))`. It answers
  samples, and becomes the rows a PromQL answer does: a range query a `time`
  column and one numeric column per series, an instant one a row per series.
  So it feeds every series kind (line, area, bar, stat, gauge, table and the
  rest) unchanged, and `instant` and `minStep` mean what they mean for PromQL.
  `unwrap` turns a parsed field into the sample:
  `quantile_over_time(0.95, {app="api"} | json | unwrap durationMs [5m]) by (route)`.

## The guard

`validateLogql` (`src/lib/logql/safety.ts`) is the LogQL counterpart of the
SQL and PromQL guards, and
[Executing a panel](/concepts/executing-a-panel/#the-logql-guard) lists its
rules. In prose:

- **One expression, made of what the walker allows.** The parser is the Loki
  project's own grammar. Pipeline stages, range functions and aggregations are
  allowlisted by the grammar node they are; a stage a newer grammar adds is
  refused until it is listed. Comments are refused.
- **Every stream selector anchored on the allowlist.** At least one `=`
  matcher with a value, on a listed label. `{app=~".*"}`, `{app!="api"}`,
  `{app=""}` and a selector anchored only on an unlisted label are refused, as
  Loki itself refuses the first three. Any other matcher on an unlisted label
  is a **hint** that never refuses.
- **No time of its own.** LogQL has no `@` and no timestamp; a `[range]` and
  an `offset` are bounded by `LOGQL_MAX_RANGE`, and an offset only looks back.
- **Bounded.** At most 8,000 characters, 32 stream selectors and 128 levels
  of nesting.

## How time becomes `start`, `end`, `step` and `limit`

The server asks the endpoint for the window itself; the expression carries no
time.

- **A log query** goes to `/loki/api/v1/query_range` for the window's newest
  lines: `direction=backward`, with a `limit` of `LOKI_MAX_ENTRIES` (1,000 by
  default, never above `MAX_QUERY_ROWS`, and the logs panel's own `limit` when
  it asks for fewer). An answer with that many lines is badged as cut on the
  panel.
- **A metric range query** goes to `/loki/api/v1/query_range` with the step
  and alignment a PromQL plan takes: the window over `PROMQL_MAX_POINTS`, never
  finer than `PROMETHEUS_MIN_STEP_MS`, raised to the panel's `minStep`. Its
  result is held to `LOKI_MAX_SERIES`.
- **An instant metric query** goes to `/loki/api/v1/query` at the window's end.

Every request is a GET. The plan dialog (**What runs** in the editor, **Show
query** on a panel) shows the expression as the endpoint receives it, each
parameter with what the server resolved it from, and the limits. See [Seeing
what actually runs](/concepts/executing-a-panel/#seeing-what-actually-runs).

## Variables and the row filter

Both enter a LogQL expression only where they are one plain value.

- **A variable** is a matcher's whole value with `=` or `!=`, in a stream
  selector or a label filter (`{env=":env"}`, `| level=":level"`), or the
  string of a `|=` or `!=` line filter (`|= ":needle"`). Never inside a regex
  or a pattern, where a value could change the expression's structure, and
  never as a label name. The server writes the picked value in as an escaped
  literal, checks each selector is still anchored, re-parses, and compares the
  tree with the original. A Loki source's variable is usually **label
  values**: `{ "sourceId": "loki-prod", "label": "env", "match": "{app=\"api\"}" }`,
  one value at a time. See [Dashboard variables](/guide/variables/).
- **The row filter** splices `tenant="<the viewer's claim>"` into every stream
  selector, including those inside range functions and on both sides of an
  operator, before the query runs. A pipeline label filter
  (`| tenant="x"`) would only narrow lines already read, so it is the stream
  selector that carries it.

A drilldown can read a clicked line's label or a series' label with
`{ "label": "app" }`: see [Drilldown](/guide/drilldown/#clicking-a-datum).

## What the server owns

| The spec says | The server decides |
| --- | --- |
| Which source, by id | Its URL, its auth, and the credential, resolved per request |
| The expression | Whether it passes the guard, and the tenant matcher spliced into it |
| A window such as `now-1h` | `start`, `end`, and for a metric query `step` and its alignment |
| A logs panel's `limit` | The `limit` sent (never above `LOKI_MAX_ENTRIES` or `MAX_QUERY_ROWS`) and `direction` |
| Nothing | The deadline, the bytes read, the series kept, and the badge that says a result was cut |

## What is refused, and why

| Refused | Because |
| --- | --- |
| A stream selector with no `=` matcher on a listed label | The allowlist is the catalog. A query reads the streams it names and nothing else. |
| A pipeline stage, range function or aggregation off the allowlist | What the guard does not know, it cannot vouch for. |
| A range or offset past `LOGQL_MAX_RANGE`, or a negative offset | The server owns time. |
| A log query as `instant` | Loki runs a log query only over a range. |
| LogQL against a SQL or Prometheus source, or the reverse | A query is in its source's language. |
| More than `LOKI_MAX_SERIES` series in a metric result | A panel aggregates. |
| A source URL that is private, loopback or plain `http` and not on `SOURCE_URL_ALLOWLIST` | The server would otherwise make requests, possibly with a credential, to any address a source admin typed. |

## Try it locally

`docker compose --profile logs up` adds a Loki and a Grafana Alloy that ships
every compose container's log lines to it. The seeder registers that Loki as
`loki-self` and seeds the **Holotable logs** dashboard, which reads the app's
own JSON log lines. See [Demo data](/operations/demo-data/#the-logs-profile).
