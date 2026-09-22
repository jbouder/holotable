---
title: The shared IR
description: The single Zod schema shared by the model, the API, persistence, and the client.
sidebar:
  order: 2
---

A panel is one object in the shared Zod IR (`src/lib/ir.ts`). Its entire
contract:

```ts
Panel = {
  id: string,                 // unique within the dashboard
  title: string,
  description?: string,       // intent only, populated for ad-hoc exploration
  viz: VizType,               // see Reference → Visualization types
  query: {
    sourceId: string,         // opaque reference into the source registry
    sql: string,              // UNTRUSTED SELECT — validated before it ever runs
    timeField?: string,       // the column the SERVER filters time on
  },
  format?: "number" | "bytes" | "percent" | "ms",
  layout: { x, y, w, h },     // position on a 12-column grid
}
```

A `Dashboard` wraps a title, a `timeRange`, a `refreshIntervalMs`, and 1–50
panels, with a refinement rejecting duplicate panel ids. The full list of
`viz` and `format` values is in
[Visualization types](/reference/visualization-types/), generated from the enum
itself.

## Three properties carry the whole security model

**`sourceId` is opaque.** No host, port, database, or credential ever lives in a
panel. The source registry (`src/lib/registry.ts`) owns the safe connection
config, the table and column allowlist (the *catalog*), and a `secret_ref` that
resolves credentials from the environment at execution time.

**`sql` is untrusted** even though the model wrote it. It is re-validated on
every save and on every execution — never trusted because "we generated it."

**There is no time filter in the query.** The model is explicitly forbidden from
filtering time. `timeField` merely *names* the column; the **server** injects
the `from`/`to` bounds. Time authority never leaves the server.

## One definition, no drift

The same `Panel` schema is the model's output type, the API's validation type,
the persisted type, and the client's render type:

```ts
export const DashboardGenerationSchema = Dashboard;
```

Because generation is bound to the same object the client renders, a spec that
would not render is a spec the model could not have emitted. This is why
changing dashboard structure means changing the Zod schema *first* and updating
every producer and consumer together — parallel ad-hoc types would reintroduce
exactly the drift this design removes.

## Time expressions

`TimeExpr` accepts a relative form (`now`, `now-15m`, `now-1h`, `now-24h`,
`now-7d`) or an ISO-8601 absolute timestamp. The IR only ever carries the
*expression*; `resolveTimeRange` (`src/lib/time.ts`) turns it into concrete
`Date` bounds server-side, and rejects a range whose `from` is not before its
`to`.

## Strictness

Every object in the IR is `.strict()`, so an unknown key is a validation error
rather than a silently ignored field. That is what makes a stored spec safe to
parse years later — and it is also why the IR needs an explicit version field
and an upgrader chain before the first breaking change
([#58](https://github.com/jbouder/holotable/issues/58)).

## Leaving and entering the app

A spec is a self-contained document, so getting one out of the app is an
envelope around it rather than a serializer
(`src/lib/dashboard-export.ts`):

```json
{
  "format": "holotable.dashboard",
  "formatVersion": 1,
  "exportedAt": "2026-09-22T12:00:00.000Z",
  "manifest": { "title": "…", "panelCount": 7, "dashboardVersion": 3, "sourceIds": ["…"] },
  "spec": { "…": "the Dashboard IR, verbatim" }
}
```

`formatVersion` versions the *envelope*, not the IR — it is the reader's signal
to refuse a file it would otherwise misread, and the place the upgrader chain
from [#58](https://github.com/jbouder/holotable/issues/58) would attach.

The manifest is informational: an import makes every decision from `spec`, so a
doctored manifest changes nothing. What an import cannot decide for itself is
what the source ids mean. They are opaque registry references, which is what
keeps the file free of hosts and credentials in the first place, and it is also
why the same file means different things in different deployments — so
`POST /api/dashboards/import` re-points them through an **explicit** mapping
supplied by the importer and refuses the whole import, naming the ids, when any
of them is still not a live source in the target workspace. Guessing by name or
by catalog shape would point a panel at the wrong database and report
plausible-looking numbers instead of an error.

## Keeping one, and applying it again

A template is the same document kept for reuse (`src/lib/templates.ts`). Its
body is a `Panel` or a `Dashboard` out of this IR, tagged with which, and
nothing else — so "IR-validated on write and on instantiation" is a property of
the schema rather than a habit, and a template is exactly as safe to keep and
hand around as the spec it was taken from.

Applying one re-points every panel at a source the reader picks, for the reason
an import does: the ids a template carries meant something in one registry, and
a template's whole purpose is to be used somewhere else. The SQL itself is
never rewritten to fit a different schema — the picker runs the guard over each
statement against the chosen source's catalog and shows what fails, and fixing
it is the author's job in the editor.

The starter templates that ship with the app are not stored at all. They are
built from a source's own catalog on request (`src/lib/builtin-templates.ts`),
the way the starter prompts are: the four golden signals, parameterized by a
table and its time column, offered only where the columns support them. That
also means they cannot drift — a built-in exists for as long as the catalog
supports it, and stops being offered when it does not.
