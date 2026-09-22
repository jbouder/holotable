---
title: Generating a panel
description: How the model authors a validated spec, and what is enforced before it ever runs.
sidebar:
  order: 3
---

Entry point: `POST /api/generate` (`src/app/api/generate/route.ts`).

The request body is a discriminated union over four modes:

| Mode | Produces | Used by |
| --- | --- | --- |
| `dashboard` | a full `Dashboard` (1–50 panels) | new-dashboard flow |
| `dashboard-refine` | a full `Dashboard` from a current spec + follow-up | refinement before the first save |
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

## The catalog has to be true before any of that matters

A catalog nobody has checked is a schema the model designs against and the
database does not have, and the author meets it as a broken panel rather than
as an error. `catalogHealth()` in `src/lib/catalog/health.ts` is the single
judgement about that, and `/api/generate` refuses before the model is called —
before the rate limit is even spent — when it is one of the two states that
cannot produce working SQL:

| State | Meaning | Generation |
| --- | --- | --- |
| `ok` | Refreshed, and everything it names still exists | proceeds |
| `never_refreshed` | Nothing has ever checked this catalog against the database — the state a model-drafted source starts in | **refused** |
| `empty` | No table it names still exists | **refused** |
| `drifted` | Some allowlisted tables no longer exist | proceeds, with a warning |
| `stale` | Last refreshed over `CATALOG_STALE_AFTER_DAYS` ago | proceeds, with a warning |

A refusal names the source and the fix, and the fix is always the same one the
source list and both pickers put one click away: refresh the catalog.

Refreshing re-reads `information_schema` for the tables already in the
allowlist. It never adds a table, and it never removes one either — a dropped
table and a revoked grant look identical from there, and only one of them
should cost an author their configuration. A table it cannot find is recorded
on the source instead, which is what makes the source read `drifted`, and its
last known columns stop being rendered into the prompt.

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

## Every panel says what it computes

Alongside `SQL_RULES`, the shared system prompt carries `DESCRIPTION_RULE`:
every panel must come back with a one-sentence `description` of **what the
query computes** — the measure, the grouping and the unit — phrased as intent.

The rule is explicit that the model must never state, estimate or invent a
result value, a threshold or a trend. It has not seen the data, and a
description that quoted a number would be the model reporting data, which is
the one thing it must not do.

`Panel.description` has always been in the IR and is still optional, so panels
saved before this rule existed load and render unchanged. The viewer shows the
description behind an info control on the panel header, and the panel editor
has a field for correcting it — a human's correction of the model's sentence is
an ordinary spec edit.

## Streaming and the once-per-action rule

`streamObject` streams the partial object to the client so the UI can render the
spec as it forms. **The model runs exactly once per author action** — never on
view, never on a refresh tick.

## Refining before the first save

Generation on `/dashboards/new` is not one-shot. After the first turn, a
follow-up ("make the third one a bar chart", "add p99 latency") sends the
**current spec** back as context and returns the whole updated dashboard, the
way a single panel's NL edit already does one level down. Each follow-up is one
author action and therefore **one model call**, and it counts against the
workspace's rate limit and token budget like any other.

The turn history is client-side and unsaved (`src/lib/dashboard-turns.ts`): each
turn keeps the prompt and the layout-normalized spec, an earlier turn can be
restored before saving, and refining from a restored turn drops the turns that
followed it. **Nothing is persisted until Save** — that is still the ordinary
`POST /api/dashboards`. The data source is locked once the first turn lands,
because every panel's `query.sourceId` must match the source the spec was
generated against.

## Keeping an Explore answer

An explore panel is a spec like any other, so Explore can pin it to a dashboard
instead of discarding it. **Save as panel** offers the dashboards in the
*source's* workspace that the caller may update (`GET
/api/dashboards?workspaceId=…&editable=true`), plus a new dashboard.

The placement is pure arithmetic over the spec (`src/lib/explore-save.ts`): the
fixed `explore` id becomes a slug of the panel title, disambiguated against the
ids already in that dashboard, and the panel lands at the bottom of the grid.
The save itself is the ordinary `PUT /api/dashboards/[id]` (which appends a new
immutable version) or `POST /api/dashboards`, so the workspace is still derived
from the trusted source records and every statement is re-validated on the way
in. A dashboard created this way opens in the editor with `?panel=<id>`
selected.

## Drafting a data source

`/api/sources/generate` applies the same shape to source registration: the model
emits only a validated `SourceDraft` — safe connection config plus a best-effort
table catalog and the `secret_ref` *name*. It is prompted to ignore any password
in the description, and it never emits a credential value. The user reviews the
draft, then runs **Test** and **Refresh** against the live database, which is the
source of truth for real columns.
