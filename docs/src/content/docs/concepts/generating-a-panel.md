---
title: Generating a panel
description: How the model authors a validated spec, and what is enforced before it ever runs.
sidebar:
  order: 3
---

Entry point: `POST /api/generate` (`src/app/api/generate/route.ts`).

The request body is a discriminated union over three modes:

| Mode | Produces | Used by |
| --- | --- | --- |
| `dashboard` | a full `Dashboard` (1–50 panels) | new-dashboard flow |
| `panel` | one updated `Panel` from a current panel + NL edit | per-panel "edit with AI" |
| `explore` | one `Panel` answering an ad-hoc question | the Explore tool |

## Before any model call

The route:

1. **Resolves identity** (`requireIdentity`).
2. **Loads the source** by `sourceId` and rejects it if missing or tombstoned.
3. **Authorizes** `dashboard:generate` against the workspace that *owns the
   source* — the workspace is taken from the trusted source record, never from
   the request body.

Only then does it hand off to `src/lib/ai/generate.ts`, which uses the AI SDK's
`streamObject` bound to the Zod IR:

```ts
streamObject({
  model: getModel(),               // env-selected provider/model
  schema: Dashboard,               // or Panel — the model's output IS the IR
  system: baseSystem(source),      // catalog metadata + strict SQL rules
  prompt: ...,
})
```

## Two things make this safe by construction

**`schema` binds the output to the IR.** The model is structurally constrained
to emit a spec shaped like `Dashboard`/`Panel` — not free-form text, and not
data rows.

**The system prompt contains only catalog *metadata*** for the single selected
source: table and column names and types from `buildCatalogPrompt(source)`. No
sample rows are ever sent to the model. It designs against a schema, not against
data.

## The SQL rules are a courtesy, not the enforcement

The `SQL_RULES` block in the prompt tells the model the house rules: SELECT-only,
no semicolons or comments, reference only allowlisted tables, **never** write a
time filter or `now()`, and for time-series always group by a time bucket, alias
it, set that alias as `timeField`, and order by it ascending.

Every one of those rules is independently *enforced* downstream. A model that
ignores them produces a spec that fails validation — not an unsafe query.

:::note
The `timeField` rule is the one most worth understanding: the server filters on
the **output column** named by `query.timeField`, so that name must be an alias
present in the SELECT list, never the raw catalog column. When the result has no
time column — a `stat` scalar or a categorical breakdown — `timeField` is
omitted entirely.
:::

## Streaming and the once-per-action rule

`streamObject` streams the partial object to the client so the UI can render the
spec as it forms. **The model runs exactly once per author action** — never on
view, never on a refresh tick.

## Drafting a data source

`/api/sources/generate` applies the same shape to source registration: the model
emits only a validated `SourceDraft` — safe connection config plus a best-effort
table catalog and the `secret_ref` *name*. It is prompted to ignore any password
in the description, and it never emits a credential value. The user reviews the
draft, then runs **Test** and **Refresh** against the live database, which is the
source of truth for real columns.
