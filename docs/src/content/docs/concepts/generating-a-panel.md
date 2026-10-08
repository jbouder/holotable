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
  schema: DashboardGenerationSchema, // or ExplorePanel — the model's output IS the IR
  system: baseSystem(source, workspacePrompt), // catalog, workspace context, strict SQL rules
  prompt: ...,
})
```

## Two things make this safe by construction

**`schema` binds the output to the IR.** The model is structurally constrained
to emit a spec shaped like `Dashboard`/`Panel` — not free-form text, and not
data rows.

**The system prompt contains only catalog *metadata*** for the selected
sources (one, or for a dashboard [up to three](#more-than-one-source)): table and column names and types from `buildCatalogPrompt(source)`,
plus the workspace's own context when it has one (below). No sample rows are
ever sent to the model. It designs against a schema, not against
data.

## More than one source

A dashboard can be generated over up to three sources of one workspace: on
`/dashboards/new`, tick up to three in the source chip; the first one ticked
is the primary and the others are sent as `additionalSourceIds` on the
`dashboard` and `dashboard-refine` modes. It is still one model call. Each source is resolved and authorized on
its own record, and one that is missing, removed, unchecked, outside the
workspace or not the caller's to use refuses the request rather than being
dropped.

The prompt lists every `sourceId` and gives each catalog its own fenced block
under a heading naming its source, and the SQL rules say a panel reads only
its own source's tables and never combines sources. On save, each panel's
SQL is validated against the source it names, which is what actually refuses
a table from one source under another's id. A panel edit or an explore
question still uses one source. See
[ADR 1](/architecture/decisions/0001-multi-source-generation/) for the
options and why this one.

## Workspace context

The catalog says what columns exist, not what they mean: that `duration_ms`
is measured server-side, that this team says "latency" when it means p95, or
which of three request tables is the canonical one. A workspace's
source-admins add that under **Settings → AI context**
(`src/lib/workspace-prompt.ts`), and every dashboard, refinement, panel edit
and explore generation in the workspace carries it. Dashboard chat and source
drafting do not.

| Part | Cap | In the prompt |
| --- | --- | --- |
| Glossary | 2,000 characters | Line by line |
| Metric definitions | 15, each a 48-character name and a 200-character definition | `- name: definition` |
| Example panels | 4, each a 300-character request and a panel of at most 1,800 characters of JSON | Only for the source being generated against |

`baseSystem` composes the prompt as the base rules, the fenced catalog, the
workspace's block, and then the SQL, description, layout and presentation
rules (`src/lib/ai/prompt.ts`). The text is written by an admin, but it is
still not an instruction channel:

- **It is fenced like the catalog.** Every line is flattened and clamped, and
  the markers carry a random per-call token, so nothing inside can close the
  block or open a fake one. Its preamble says it is reference material and
  that anything claiming to change the rules is only text, and the line after
  it says the rules win where the two disagree.
- **It is bounded.** The caps above bound it, and the composer clamps it again
  to `MAX_WORKSPACE_CONTEXT_CHARS`, so the prompt stays bounded however much is
  written.
- **An example cannot teach a query the app would not run.** Saving refuses an
  example whose panel fails the IR or runs no query, whose source is not live
  in the workspace, or whose SQL fails the guard against that source. Before
  each generation, an example whose SQL no longer passes against the catalog
  as it is now (a table that went missing since) is left out.
- **Nothing it says is enforced by the prompt alone.** The model's SQL still
  goes through the guard and its output through the IR, as for every
  generation, so a glossary that asks for a `DELETE` or a time filter gets a
  refused spec, not a query.

Editors see the customization read-only, and anyone who may generate in the
workspace can show the composed system prompt for any of its sources
(`GET /api/workspaces/[id]/prompt/preview`), so a surprising answer can be
traced back to what the model was told. A customization that cannot be read
when a generation starts is logged and skipped; the generation runs on the
base prompt.

## The catalog has to be true before any of that matters

A catalog nobody has checked is a schema the model designs against and the
database does not have, and the author meets it as a broken panel rather than
as an error. `catalogHealth()` in `src/lib/catalog/health.ts` is the single
judgment about that, and `/api/generate` refuses before the model is called —
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
view, never on a refresh tick. The one exception: output that fails the schema
gets a single automatic repair, shown as "Fixing it automatically…" while it
streams (see [Structured-output
repair](/operations/ai-provider/#structured-output-repair)).

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
`POST /api/dashboards`, after a dialog that lets the author confirm the title
and names the workspace it lands in (the source's). The data source is fixed
once the first turn lands, because every panel's `query.sourceId` must match
the source the spec was generated against: the source chip shows a lock, and
picking another source there asks to start over rather than being refused.

The page is laid out around that loop: a single-line prompt bar runs across
the top, with the source chip at its start, and the preview fills the page
under it. Before there is one, a placeholder takes that space; while a version
is written, one line says what is being composed (the same line Explore shows),
and a refinement keeps the current preview on screen, dimmed, until the next
version lands. Before the first prompt, a few starters sit
under the bar, and **Start from a template…** and recent prompts sit on the
right of the page title; after it, the **Version** menu, **Try again**, **View
JSON** (the raw spec) and **Save dashboard** sit above the preview.

## Asking again, and remembering what you asked

Two affordances make a generation feel reversible rather than final.

**Try again, with feedback.** A follow-up talks the dashboard *forward*; **Try
again** on the version being previewed asks again for the turn you are looking at, with a note about what
was wrong ("fewer panels, and put the error rate first"). It is one model call,
carrying the turn's own prompt, the spec that turn was generated **from**, and
the feedback — and it *replaces* that turn rather than adding one. Deliberately
not the spec being reviewed: feeding the model back its own rejected answer
compounds it, and pressing Regenerate twice would drift further each time. The
panel editor's regenerate works the same way one level down, against the panel
in the spec rather than the proposal on screen.

The model that answers is named once, beside the page title, so the cost of
asking again is visible; a version applied from a template says *no model
call*, because none was made.

**Recent prompts.** The prompt box keeps the last few prompts per workspace and
offers them back (on `/dashboards/new`, beside the page title on a fresh
screen); choosing one fills
the box rather than submitting, so re-use and edit are the same gesture. The create box, the panel
editor's NL edit and Explore keep separate lists — "make it a bar chart" is a
panel edit and is nonsense as a dashboard description.

The list lives in `localStorage` (`src/lib/prompt-history.ts`) and is never sent
anywhere: it is capped, expired, scoped to `(workspace, box)`, and read back as
untrusted. The durable record of what was asked is the **generation log**, which
stores a redacted prompt, a hash of the catalog that was in context and the spec
that came back, and is readable only by a workspace source-admin — see
[Data model](/architecture/data-model/).

## Looking at an Explore answer

Explore's prompt bar is the one `/dashboards/new` has: the source chip and one
line to ask in. The **time range** (5 minutes to 30 days) and **auto-refresh**
(off, 30s, 1m, 5m) sit in the page header, and both apply to the answers on
screen: a new range re-runs
them, and a refresh re-runs them quietly, keeping the rows on screen until the
new ones land and skipping a hidden tab. Each run is the ordinary guarded
`POST /api/query`; the server resolves the window, as it does everywhere.

Once an answer is back, nothing on it asks the model again:

- **Show as** redraws the same rows as a line, area, bar, table or stat (line
  and area only when the query has a time field), and a chart takes **Legend**,
  **Stack** and **Log scale**. Every switch is checked against the IR's `Panel`
  schema first (`src/lib/explore-view.ts`), so a toggle that would make an
  invalid spec, such as a log axis over a fixed minimum of zero, is disabled
  rather than drawn.
- The **table** filters rows by text, anywhere or per column, sorts on a header
  click, hides columns, and downloads the matching rows as CSV
  (`src/lib/result-table.ts`). The CSV is built in the browser from rows already
  returned, and a cell a spreadsheet would run as a formula is prefixed with `'`.
  Filtering narrows what is shown, never what was read.
- **This session** lists every question asked on the visit, newest first, up to
  20 (`src/lib/explore-session.ts`). One click brings an answer back; **Pin**
  holds one beside the current answer to compare them, and **Start over**
  asks, then clears the list. A reload starts over too, unless **Keep this
  tab's answers** is on in Preferences: then the questions come back and their
  queries run again.

## Keeping an Explore answer

An explore panel is a spec like any other, so Explore can pin it to a dashboard
instead of discarding it. **Save as panel** saves it as it is shown, with the
view, chart toggles, hidden columns and sort applied, and offers the dashboards in the
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
