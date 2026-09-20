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
