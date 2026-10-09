# The spec format (the IR)

The canonical schema is `src/lib/ir.ts` (Zod). Every object below is
**strict**: an unknown key is an error, not ignored. Lengths are inclusive.

## The file a person imports

A dashboard leaves and enters Holotable as an export file. Write this shape;
the author imports it in the app (Dashboards → Import), where each `sourceId`
is mapped to a real source in their workspace.

```json
{
  "format": "holotable.dashboard",
  "formatVersion": 1,
  "spec": { "specVersion": 1, "title": "…", "timeRange": {…}, "refreshIntervalMs": 15000, "panels": [ … ] }
}
```

`exportedAt` and `manifest` are optional and informational; leave them out.

## Dashboard (`spec`)

| Field | Type | Rules |
|---|---|---|
| `specVersion` | `1` | Required, exactly `1` for this build. |
| `title` | string | 1–200 chars. |
| `timeRange` | `{ from, to }` | Time expressions, below. The default window a viewer sees. |
| `refreshIntervalMs` | integer | 1000–3600000. The server enforces a floor (2000 ms by default); 15000 is the usual default. |
| `panels` | Panel[] | 1–50. `id`s unique within the dashboard. |
| `variables` | Variable[] | Optional, up to 10, names unique. |
| `annotations` | `{ show?, tags? }` | Optional. `show` (default on) draws the workspace's annotations on time-series panels; `tags` (up to 10, each `[A-Za-z0-9_.:-]`, 1–32 chars) keeps only those carrying one of them. |

## Panel

| Field | Type | Rules |
|---|---|---|
| `id` | string | 1–64 chars, unique in the dashboard. A short slug: `error-rate`. |
| `title` | string | 1–200 chars. |
| `description` | string | Optional, up to 500. One sentence on WHAT the query computes (measure, grouping, unit). Never a value, threshold or trend. |
| `viz` | kind | One of the kinds in `panel-kinds.md`. |
| `query` | Query | Required for every kind except `text`, which must not have one. |
| `options` | object | Optional; the kind's own options, checked against that kind. |
| `format` | format | Optional; how numbers are written. |
| `timeRange` | `{ from, to }` | Optional; this panel's own window instead of the dashboard's. Not on `text`. |
| `refreshIntervalMs` | integer | Optional; this panel's own cadence, same bounds. Not on `text`. |
| `links` | Link[] | Optional, 1–5. Where the panel leads; see Link below. Not on `text`. |
| `layout` | `{ x, y, w, h }` | Required. Integers: `x` 0–12, `y` 0–1000, `w` 1–12, `h` 1–48. |

Value formats: `number`, `bytes`, `percent`, `ms`

- `number` (or no format): grouped digits.
- `bytes`: the raw value is bytes; written as KB, MB, …
- `percent`: the raw value is already 0–100, so `12.5` is written `12.5%`.
  Multiply a ratio by 100 in SQL.
- `ms`: the raw value is milliseconds.

Color tokens: `success`, `warning`, `danger`, `info`, `neutral`, `orange`, `purple`, `teal`

Colors are always one of these names (thresholds, state colors), never a hex
value or a CSS color.

## Query

A query is SQL or PromQL, decided by which of `sql` and `promql` it carries;
never both. Which one a panel may use is its source's: a TimescaleDB source
answers SQL, a Prometheus source PromQL, and a query in the other language is
refused like a table the source does not have.

SQL:

| Field | Type | Rules |
|---|---|---|
| `sourceId` | string | 1–128 chars. An opaque id of a registered source. It is never a host, URL or connection string. |
| `sql` | string | 1–8000 chars. One guarded SELECT; see `sql-rules.md`. |
| `timeField` | string | Optional, 1–128 chars, a bare identifier. The OUTPUT column the server filters the time window on. Set it for every time series; omit it when the result has no time column. |

PromQL:

| Field | Type | Rules |
|---|---|---|
| `sourceId` | string | 1–128 chars, as for SQL. |
| `promql` | string | 1–8000 chars. One PromQL expression. It carries no time: the server picks `start`, `end` and `step`. |
| `instant` | boolean | Optional. One sample per series at the end of the window instead of a range: for `stat`, `gauge`, `pie` and `table`. |
| `minStep` | duration | Optional: a whole number followed by `ms`, `s`, `m`, `h` or `d` (`15s`, `1m`). Only raises the step the server picks. |

A PromQL query has no `timeField`. A range query's rows always carry their time
in a column called `time`, which is what a time series draws; an instant query
has none, so a kind that needs time (`state-timeline`) needs a range query.

## Time expressions

`now`, or `now-<n><unit>` with unit `s`, `m`, `h`, `d` or `w` (`now-15m`,
`now-24h`, `now-7d`), or an ISO-8601 instant (`2026-10-01T00:00:00Z`). Nothing
else: no `now/d` rounding, no `+`. The server resolves them; a spec never
holds a computed time.

## Variable

A name a panel's SQL references as `:name`, and the values a viewer may pick.
The server binds the value as a parameter; it never enters the SQL text.

| Field | Type | Rules |
|---|---|---|
| `name` | string | `^[a-z][a-z0-9_]{0,31}$`. |
| `label` | string | Optional, 1–64; what the picker is labeled. |
| `type` | `"enum"` or `"query"` | |
| `values` | string[] | `enum` only, required there: 1–200 unique strings, each 1–256 chars. |
| `query` | `{ sourceId, sql }` or `{ sourceId, label, match? }` | `query` only, required there. SQL: a guarded SELECT whose first column is the values. Prometheus: the values of the label `label` (a label name), optionally narrowed by `match`, a series selector such as `up{job="api"}`. No time filter, and no `:variables` of its own. |
| `multi` | boolean | Several values at once, bound as an array: write `col = ANY(:name)`. |
| `default` | string or string[] | Optional. An array only when `multi`. For `enum`, each default must be one of `values`. By default the first value. |

## Link

Where a panel leads: another dashboard in the same workspace, or this one with
a variable set ("click to filter"). A link carries the viewer's window and
picks and sets variables on arrival. It never holds a URL or SQL, and the
target checks every pick against its own variable, as for a hand-typed link.

| Field | Type | Rules |
|---|---|---|
| `title` | string | 1–64 chars, unique among the panel's links. What the menu item or the click says. |
| `dashboard` | string | Optional, 1–128. The target dashboard's opaque id, never a URL. Absent: this dashboard. |
| `carry` | `{ timeRange?, variables? }` | Optional booleans, each `true` when absent. `false` lands on the target's own default. |
| `set` | object | Optional, at most 10 entries, keyed by variable name. Each value is exactly one of `{ "value": "api" }` (a literal), `{ "column": "instance" }` (the clicked row's value in that result column) or `{ "series": true }` (the clicked series or slice name). |
| `newTab` | boolean | Optional, default `false`. |

- A link whose `set` reads a `column` or the `series` is followed by clicking a
  point, slice, cell or row. Any other link is followed from the panel's menu.
- A link with no `dashboard` must `set` at least one variable, and only
  variables this dashboard declares.
- A `column` must be an output column of the panel's query.

```json
"links": [
  { "title": "Instance detail", "dashboard": "9b2c41d0", "set": { "instance": { "column": "instance" } } },
  { "title": "Filter to this service", "set": { "service": { "series": true } } }
]
```

## Layout

A 12-column grid; `y` counts rows downward. The schema does not refuse an
overlap or `x + w > 12`, but the grid will look broken, so never write either.
Lay panels out left to right, top to bottom.
