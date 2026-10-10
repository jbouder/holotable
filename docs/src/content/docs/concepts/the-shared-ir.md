---
title: The shared IR
description: The single Zod schema shared by the model, the API, persistence, and the client.
sidebar:
  order: 2
---

**IR** stands for *intermediate representation*: the dashboard spec the model
writes and everything else reads. It sits between the natural-language prompt
and the rendered dashboard, the way a compiler's IR sits between source and
machine code, and it is the one format every layer agrees on.

A panel is one object in the shared Zod IR (`src/lib/ir.ts`). Its entire
contract:

```ts
Panel = {
  id: string,                 // unique within the dashboard
  title: string,
  description?: string,       // intent only, populated for ad-hoc exploration
  viz: VizType,               // see Reference → Visualization types
  query?:                     // absent exactly for a kind that runs none (text)
    | {
        sourceId: string,     // opaque reference into the source registry
        sql: string,          // UNTRUSTED SELECT — validated before it ever runs
        timeField?: string,   // the column the SERVER filters time on
      }
    | {
        sourceId: string,
        promql: string,       // UNTRUSTED PromQL, for a Prometheus source
        instant?: boolean,    // one sample per series instead of a range
        minStep?: Duration,   // a floor on the step the SERVER picks ("15s")
      },
  options?: object,           // the kind's own; see Reference → Panel options
  format?: "number" | "bytes" | "percent" | "ms",
  timeRange?: { from, to },   // the panel's own window, in place of the dashboard's
  refreshIntervalMs?: number, // the panel's own cadence, same bounds as the dashboard's
  layout: { x, y, w, h },     // position on a 12-column grid
}
```

A `Dashboard` wraps its `specVersion`, a title, a `timeRange`, a
`refreshIntervalMs`, 1–50 panels, up to 10 optional `variables`
([Dashboard variables](/guide/variables/)) and an optional `annotations`
setting ([Annotations](/guide/annotations/)), with a refinement rejecting
duplicate panel ids and variable names. A panel may carry a
`timeRange` and a `refreshIntervalMs` of its own
([#114](https://github.com/jbouder/holotable/issues/114)): a "today so far"
stat over 24 hours next to a five-minute error chart. Its window wins over both
the dashboard's and the one a viewer picks, and the viewer shows a badge on it.
The server resolves either window the same way and holds either cadence to
`MIN_REFRESH_INTERVAL_MS`. A text panel takes neither. The full list of
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

## A query's language follows its source

A panel's query is SQL or PromQL, decided by which of `sql` and `promql` it
carries ([#383](https://github.com/jbouder/holotable/issues/383)). Both shapes
are strict and each has a field the other lacks, so every spec saved before
PromQL existed parses exactly as it did, with no `specVersion` bump, and a query
carrying both is refused.

Which language a panel may use is not the panel's choice. It is a property of
its source's kind ([Source kinds](/architecture/data-model/#source-kinds)): a
TimescaleDB source answers SQL, a Prometheus source answers PromQL, and a query
in the other language is refused on save and at execution like a table the
source does not have.

A PromQL query carries no time either. The server picks `start`, `end` and
`step` for the window it resolved, and `minStep` can only raise the step. A
range query's rows always carry their time in a column called `time`. An
`instant` query has one sample per series and no time column, so a kind that
needs time, such as a state timeline, needs a range query.

Code never reads a query's fields to decide what it is. It asks the helpers
beside `hasQuery` in `src/lib/ir.ts`: `isSqlQuery`, `queryLanguage`,
`queryTimeField` (the declared column for SQL, `time` for a PromQL range query,
nothing for an instant one) and `queryText` (the statement, for display, digests
and diffs). A `query` variable has the same two shapes: a SELECT, or
`{ sourceId, label, match? }`, the values of a Prometheus label.

## One definition, no drift

The same `Panel` schema is the model's output type, the API's validation type,
the persisted type, and the client's render type:

```ts
export const DashboardGenerationSchema = z
  .object({
    ...DashboardFields, // the Dashboard's own fields, minus specVersion
    panels: z.array(GeneratedPanel).min(1).max(50),
  })
  .strict()
  .superRefine(dashboardRules); // unique ids, self links set declared variables
```

There are two differences. The first is `specVersion`: which shape a spec is in
is a fact about the build, so `fromGenerated` stamps it rather than letting the
model assert it.

The second is how a panel is spelled for the model
([#335](https://github.com/jbouder/holotable/issues/335)). `Panel` keeps
`query` optional because a text panel has none, and says which kinds need one
in a refinement. JSON Schema cannot carry a refinement, so a model reading the
schema it was bound to saw `query` as optional, and one model left it off every
panel. `GeneratedPanel` says the same thing in its shape instead: a union on
`viz`, in which a kind that runs a query requires `query` and a query-less kind
has none. `ExplorePanel` (the MCP `generate_panel` tool) and Chat's `ChatPanel` offer only the first, without links. Both shapes are
`Panel`s, held to the same refinement, so everything after generation is
unchanged. Because generation is bound to the same fields the client renders, a spec that
would not render is a spec the model could not have emitted. This is why
changing dashboard structure means changing the Zod schema *first* and updating
every producer and consumer together — parallel ad-hoc types would reintroduce
exactly the drift this design removes.

The `viz` values follow the same rule from the other end. They are not written
out in `ir.ts`: `VizType` is built from the panel registry
(`src/lib/panels/registry.ts`), which also builds the prompt's list of kinds and
is the key to the client's renderers. See
[Panel kinds](/concepts/streaming-and-rendering/#panel-kinds).

## Links

A panel may declare `links`
([#371](https://github.com/jbouder/holotable/issues/371)): where it leads when
a viewer investigates further. A link targets another dashboard in the same
workspace by its **id**, or, with no id, the dashboard it is on. It is never a
URL, so there is nothing in a spec a model could point outside the app.

```json
"links": [
  {
    "title": "Host detail",
    "dashboard": "9b2c41d0",
    "carry": { "timeRange": true, "variables": true },
    "set": { "host": { "column": "host" } }
  }
]
```

- `carry` says whether the viewer's window and variable picks go along. Each
  is `true` when absent.
- `set` makes picks on arrival, by variable name. A value is a literal
  (`{ "value": "api" }`), the clicked row's value in a result column
  (`{ "column": "host" }`), or the clicked series' name (`{ "series": true }`).
- A panel takes at most 5 links, a link sets at most 10 variables, and a text
  panel takes none.
- A link to the same dashboard must set at least one variable, and only ones
  the dashboard declares. A link to another dashboard is not checked against
  that dashboard's variables: the target ignores a name it does not declare.

A link carries time expressions and picks, never SQL. The target page
resolves the window on the server and checks every pick against its own
variable, exactly as it does for a hand-typed `var-*` URL. `isDatumLink` and
`isSelfLink` in `src/lib/ir.ts` are the two derived facts every consumer
reads, so none re-derives them.

## Time expressions

`TimeExpr` accepts a relative form (`now`, `now-15m`, `now-1h`, `now-24h`,
`now-7d`) or an ISO-8601 absolute timestamp. The IR only ever carries the
*expression*; `resolveTimeRange` (`src/lib/time.ts`) turns it into concrete
`Date` bounds server-side, and rejects a range whose `from` is not before its
`to`.

## Strictness

Every object in the IR is `.strict()`, so an unknown key is a validation error
rather than a silently ignored field. That is what makes a stored spec safe to
parse years later, and it is also why the IR carries an explicit
`specVersion` and an upgrader chain (`src/lib/ir/upgrade.ts`,
[#58](https://github.com/jbouder/holotable/issues/58)): a breaking change bumps
`SPEC_VERSION` and appends an upgrader, and anything that reads a stored spec
reads it through `StoredDashboard`. See
[invariant 3](/architecture/invariants/#3-specs-are-immutable-and-versioned).

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
to refuse a file it would otherwise misread. The spec inside carries its own
`specVersion` and is read through `StoredDashboard`, so a file exported by an
older build is upgraded on import like any stored spec.

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
