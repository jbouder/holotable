---
name: holotable
description: Write, review and fix Holotable dashboard and panel specs (the JSON IR) and their guarded SQL. Use when someone wants a Holotable dashboard or panel written from a description and a table catalog, asks why a spec or query is rejected, wants a spec reviewed or explained, or asks which panel kind, format, threshold or layout to use. Knowledge only; it never connects to a Holotable server.
---

# Holotable specs

Holotable renders live monitoring dashboards from a **spec**: a JSON document
that says what to query and how to draw it, never the data. Specs are checked
by a shared Zod schema (the IR, `src/lib/ir.ts`) and every query by a SQL guard
(`src/lib/sql/safety.ts`). This skill writes specs that pass both on the first
try and advises on making them readable.

It is knowledge only. Do not call a Holotable server, sign in, or ask for a
connection string, host or password; none is needed. A spec refers to its data
by an opaque `sourceId` and nothing else. If someone pastes credentials, do not
repeat them.

## Load what the task needs

- `references/ir.md`: every field, its type and bounds; the import file
  wrapper; time expressions; variables; layout. Load for any spec you write or
  review.
- `references/panel-kinds.md`: each `viz` kind, the result shape its query must
  return, and its `options`.
- `references/sql-rules.md`: what the guard refuses and the exact error text;
  how the server injects the time window. Load before writing SQL or
  explaining a rejection.
- `references/guidance.md`: which kind answers which question, measures,
  formats, thresholds, layout and naming.
- `examples/`: `catalog.json` (a source catalog), `service-health.json` and
  `per-host.json` (complete import files using every kind and variables),
  `sql.json` (accepted and rejected statements per rule). All are tested
  against the real schema and guard.

## Write a spec from a description

1. **Get the catalog.** You need the source's tables, columns and their types,
   and its `sourceId`. Ask the person to paste or describe them (Holotable's
   Data sources page lists each source's id and has a catalog browser showing
   its tables and columns), or read them from a schema in the repository. Never
   invent a table or column. If a column is marked `"exposed": false`, or the
   person says it is hidden, do not use it.
2. **Plan the panels** with `references/guidance.md`: the questions the
   dashboard answers, one panel per question, the kind that answers each, and
   the top-row stats.
3. **Write each query** to `references/sql-rules.md`: SELECT only; no time
   filter; bucket and alias the time column and set `query.timeField` to the
   alias for every time series; omit it otherwise; only catalog tables and
   exposed columns.
4. **Assemble the file** in the import wrapper from `references/ir.md`, with
   `specVersion: 1`, unique panel ids, a one-sentence `description` per panel
   (intent, never values), and a layout with no overlaps on the 12-column
   grid.
5. **Check it yourself** against the field bounds and the kind's rules before
   handing it over: the kind's required query and time field, its options,
   and the format the raw value is in.
6. **Hand it over** as a `.json` file, and say: import it in Holotable from
   Dashboards → Import, map `sourceId` to the right source, and the app
   validates it again on import. Note any placeholder thresholds.

For a single panel, write the Panel object, and wrap it in a one-panel
dashboard file when the person wants something they can import as it is.

## Review or explain a spec

Read it against `references/ir.md` and `references/panel-kinds.md`, then
report, most serious first:

- what will be **refused** on import (schema and guard), with the field path
  and the fix;
- what will **validate but mislead**: a `timeField` that is not an output
  column, a series missing `ORDER BY` on its time column, a percent format on
  a 0–1 ratio, an average where a percentile is meant, a pie with dozens of
  slices, overlapping layout;
- what would **read better**: kind choice, layout order, titles, units,
  thresholds.

## Explain and fix a rejection

Match the message to the table in `references/sql-rules.md` (for SQL) or to
the field rules in `references/ir.md` (for the schema; messages read
`path: problem`, such as `panels.2.options.thresholds.1.value: threshold steps
must be in strictly ascending order of value`). Say which rule it is, why the
rule exists (the server owns time, the catalog is an allowlist, the model never
supplies data), and give the corrected spec or statement.
