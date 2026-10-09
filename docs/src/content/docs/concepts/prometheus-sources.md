---
title: Prometheus sources
description: A Prometheus-compatible endpoint as a data source. Its catalog is metrics, its panels are PromQL, and the server still owns the window.
---

A source has a **kind** ([ADR 2](/architecture/decisions/0002-source-kinds/)).
A TimescaleDB/PostgreSQL source answers SQL. A **Prometheus** source answers
PromQL: Prometheus itself, or anything that speaks its HTTP query API, such as
Thanos, Mimir or VictoriaMetrics. Everything the app guarantees about a SQL
panel holds for a PromQL one. The model writes a spec and never data. The query
is untrusted and guarded. The server owns the time window. A spec names its
source by an opaque id and nothing else.

## The source

A Prometheus source's config is its endpoint and its catalog:

```json
{
  "kind": "prometheus",
  "url": "https://prometheus.example.com",
  "auth": "bearer",
  "metrics": [
    { "name": "http_requests_total", "type": "counter", "help": "Requests served.", "labels": ["code", "instance", "job", "route"] },
    { "name": "up", "type": "gauge", "labels": ["instance", "job"] }
  ],
  "rowFilter": { "label": "tenant", "claim": "tenant" }
}
```

- **`url`** is where the server sends queries. A source admin chooses it, so it
  is held to the same rules as a model base URL: public `https` unless the
  operator's `SOURCE_URL_ALLOWLIST` names the host, no credentials in it, and
  no redirects followed. See [Prometheus operations](/operations/prometheus/).
- **`auth`** is `none`, `bearer` or `basic`. The credential is never in the
  config. A source with `bearer` or `basic` names a
  [`secret_ref`](/operations/secret-references/#prometheus-sources), and the
  server resolves `<REF>_TOKEN` or `<REF>_USERNAME`/`<REF>_PASSWORD` when it
  connects. `none` is for an in-cluster endpoint and names no ref.
- **`metrics`** is the allowlist, the PromQL counterpart of a SQL source's
  tables. Each metric has a type, an optional help line and the labels its
  series carry. A histogram is listed as its series: `…_bucket` (with `le`),
  `…_count` and `…_sum`. An expression may select only listed metrics.
- **`rowFilter`** is optional. It names a tenant label every listed metric
  carries, and the identity claim whose value the viewer's queries are
  narrowed to. See [row-level filters](/operations/row-level-filters/#on-a-prometheus-source).

The **Data sources** page registers one through the same dialog as a database,
with **Prometheus (PromQL)** as the kind. **Discover metrics** reads the
endpoint's metadata and offers a searchable menu, since a real server has
thousands of metrics, and ticking one asks the endpoint for its labels.
**Test** checks the connection, the auth, the build and the write surface, read
from the endpoint's flags and never probed, then confirms that each allowlisted
metric has series. **Refresh** re-reads the labels and types without adding or
dropping a metric: the allowlist stays the author's.

## A PromQL panel

A panel on a Prometheus source carries `query.promql` instead of `query.sql`,
and no `timeField`:

```json
{
  "id": "rps",
  "title": "Requests per second by route",
  "viz": "line",
  "query": {
    "sourceId": "prom-prod",
    "promql": "sum by (route) (rate(http_requests_total[5m]))",
    "minStep": "1m"
  },
  "layout": { "x": 0, "y": 0, "w": 6, "h": 4 }
}
```

A panel's language is its source's. A PromQL panel pointed at a SQL source is
refused by name ("source answers SQL; this query is PromQL") wherever it would
run, and so is the reverse. The editor never saves one: moving a panel to a
source of the other kind restarts its query from that source's starter.

**`instant`** asks for one sample per series at the window's end instead of a
range. It is for kinds that draw one value per series: a stat, a gauge, a
table, a pie or donut, and a bar compared across a label. **`minStep`** is a
floor on the step. The server picks the step and only ever raises it.

The result's shape is what the panel kinds read:

- **A range query** answers a `time` column and one numeric column per series,
  named the way the Prometheus UI names a legend entry: `{route="/api"}`, or
  `metric{…}` when the series have different names. So a line has one line per
  series, and `sum by (route) (…)` decides what those are.
- **An instant query** answers one row per series, one column per label, then
  `value`.

`heatmap`, `scatter` and `state-timeline` read row shapes a PromQL result does
not have, and the model is told not to use them for a Prometheus source.

## The guard

`validatePromql` (`src/lib/promql/safety.ts`) is the PromQL counterpart of the
SQL guard, and [Executing a panel](/concepts/executing-a-panel/#the-promql-guard)
lists its rules. In prose:

- **One expression, made of what the walker allows.** The parser is the
  Prometheus project's own grammar. Comments, the experimental functions and
  `info()` are refused, as is anything the walker does not know.
- **Only listed metrics.** Every selector names exactly one metric, and that
  metric is on the allowlist. A selector without a name, or with a `__name__`
  pattern, could read any metric, so it is refused.
- **No time of its own.** The `@` modifier is refused in every spelling, and a
  range, subquery or `offset` is bounded by `PROMQL_MAX_RANGE`. The `[5m]` in
  `rate(…[5m])` is a lookback, not a window, and is fine.
- **Bounded.** At most 8,000 characters, 32 selectors and 64 levels of nesting.
  A subquery evaluates at most 11,000 points.

The guard also gives **hints** that never refuse: a label the catalog does not
list for a metric, `rate()` over a gauge, and a counter drawn without `rate()`
or `increase()`. The editor underlines them in place.

## How time becomes `start`, `end` and `step`

A SQL panel is windowed by a `WHERE` the server adds on `timeField`. A PromQL
panel has no `WHERE`: the server asks the endpoint for the window itself.

- **A range query** goes to `/api/v1/query_range`. `start` and `end` are the
  dashboard's (or the panel's) window, resolved on the server and aligned down
  to a multiple of the step, so two polls a few seconds apart ask for the same
  points. The step is the window divided by `PROMQL_MAX_POINTS` (1,000 by
  default), never finer than `PROMETHEUS_MIN_STEP_MS` (15 s), and raised to the
  panel's `minStep` when it sets one.
- **An instant query** goes to `/api/v1/query` with `time` at the window's
  end.

The plan dialog (**What runs** in the editor, **Show query** on a panel) shows
the expression as the endpoint receives it, each parameter with what the server
resolved it from, and the limits. See [Seeing what actually
runs](/concepts/executing-a-panel/#seeing-what-actually-runs).

## Variables and the row filter as matchers

Both enter a PromQL expression the only way that cannot change what it is: as
a label matcher's value.

- **A variable** is written as a matcher's whole value, `{host=":host"}`, or
  `{host=~":host"}` for several values. The server writes the picked value in
  as an escaped string literal, re-parses the result and checks the tree is
  the original with only those literals changed. A variable anywhere else is
  refused. A Prometheus source's variable is usually **label values**:
  `{ "sourceId": "prom-prod", "label": "instance", "match": "up{job=\"node\"}" }`.
  See [Dashboard variables](/concepts/variables/).
- **The row filter** adds `tenant="<the viewer's claim>"` to every selector,
  including those inside functions and subqueries, before the query runs. The
  viewer's queries cannot read another tenant's series, however they are
  written.

A drilldown can read one label of a clicked series with `{ "label": "instance" }`:
see [Drilldown](/concepts/drilldown/#clicking-a-datum).

## What is refused, and why

| Refused | Because |
| --- | --- |
| A metric not on the allowlist, or a selector that names none | The allowlist is the catalog. A query reads what it lists and nothing else. |
| `@`, or a range or offset past `PROMQL_MAX_RANGE` | The server owns time. |
| PromQL against a SQL source, or SQL against a Prometheus one | A query is in its source's language. |
| More than `PROMETHEUS_MAX_SERIES` series in a result | A panel aggregates. A thousand lines read as one smear. |
| A native histogram in a result | Its buckets do not fit a row, so the panel says so instead of drawing something wrong. |
| A source URL that is private, loopback or plain `http` and not on `SOURCE_URL_ALLOWLIST` | The server would otherwise make requests, possibly with a credential, to any address a source admin typed. |
