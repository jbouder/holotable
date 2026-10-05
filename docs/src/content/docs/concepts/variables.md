---
title: Dashboard variables
description: Switching a dashboard between hosts, regions or environments, with every value bound as a parameter and checked against what the variable allows.
sidebar:
  order: 7
---

A dashboard can declare **variables**
([#67](https://github.com/jbouder/holotable/issues/67)): a name panel SQL
references as `:name`, and the values a viewer may pick for it. Showing the same
panels for another host is a different pick, not a second dashboard.

```json
{
  "variables": [
    { "name": "env", "type": "enum", "values": ["prod", "staging"] },
    {
      "name": "host",
      "label": "Host",
      "type": "query",
      "query": {
        "sourceId": "ts-system",
        "sql": "SELECT DISTINCT host FROM metrics.system_metrics ORDER BY 1"
      },
      "multi": true
    }
  ],
  "panels": [
    {
      "query": {
        "sql": "SELECT time_bucket('1 minute', ts) AS t, avg(cpu_pct) AS cpu FROM metrics.system_metrics WHERE host = ANY(:host) GROUP BY 1 ORDER BY 1",
        "timeField": "t"
      }
    }
  ]
}
```

## Declaring one

| Field | Meaning |
| --- | --- |
| `name` | Lowercase letters, digits and `_`, starting with a letter, at most 32. Panel SQL writes it as `:name`. |
| `label` | What the picker says; the name by default. |
| `type` | `enum`: the values are listed in `values`. `query`: the values are the first column of `query.sql` against `query.sourceId`. |
| `multi` | Several values at once, bound as an array: write `col = ANY(:name)`. |
| `default` | The selection before a viewer picks. One of `values` for an `enum`; a list for a `multi` variable. Without one, the first value. |

At most 10 variables, 200 values each, 256 characters a value. A `query`
variable's statement passes the same guard as a panel's, reads a source in the
dashboard's workspace, has no time filter, and references no variable.

## A value is never SQL

The obvious implementation, writing the picked value into the statement, would
let a string a browser sent become SQL. Holotable never does that.

- **Found by the server's own scanner.** A reference is a `:` token followed
  immediately by a name, as PostgreSQL's scanner (the `libpg-query` build the
  guard parses with) tokenizes the statement. `':host'` is a string, `x::host`
  is a cast, and `"…:host…"` is an identifier, exactly as the database reads
  them. `: host` with a space is not a reference, and the parser refuses it.
- **Declared or refused.** `validateSql` refuses a reference to a variable the
  dashboard does not declare, and a `$n` the statement spells itself. It then
  checks the statement as it will run, with each reference replaced by a
  placeholder.
- **Bound, not written.** `buildExecutablePlan` replaces each reference with a
  `$n` after the time bounds and the row-filter value, and puts the value in
  the parameter list. `test/sql-variables.test.ts` and a property in
  `test/sql-safety.fuzz.test.ts` assert that no value ever reaches the text.
- **Allowed, or a 400.** The stream route reads the picks from `var-<name>`
  parameters, repeated for a multi-value variable, and checks each against what
  the variable allows *this viewer*: an `enum`'s list, or what its query
  returns now. On a row-filtered source that is only the viewer's rows. A value
  outside that is refused with a `400` naming it; nothing runs.
- **Part of the poller key.** Viewers share a poller only when their picks are
  equal, so two selections never see each other's results.

## Picking and editing

The viewer shows one picker per variable beside the time controls, offering the
values the page computed for this viewer, and keeps the picks in the URL, so a
selection is a link. The editor's **Variables** card declares them. The panel
preview, the "What runs" view and the dashboard preview bind each variable's
default, or its first value; a `query` variable's values come from
`POST /api/variables/options`, which runs its guarded query as the author and is
audited like any other preview query.

Dashboard chat binds defaults too. A `query` variable without a default has no
value there, and a chat query that references it is refused by name.

Known gaps: deleting or hiding a column only a variable's query reads is not
yet listed in the impact warnings, which look at panels.
