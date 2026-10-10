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
| `explore` | one `Panel` answering an ad-hoc question | the MCP `generate_panel` tool |

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
question still uses one source.

One call over fenced catalogs, rather than one call per source merged
afterwards or a routing call followed by per-source generation, is what keeps
invariant 1: a multi-source dashboard is still one author action and one model
call, budgeted, rate limited, logged and repairable like any other, and a
single-source request produces exactly the prompt it did before (#104). The
cap of three is what bounds the prompt; the author chooses whether to pay for
it. Cross-source joins stay out of scope, since a query runs against one
source's connection. If quality across sources ever needs routing, that
changes invariant 1 and is a separate decision.

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

## Other dashboards, for links

A generation that writes a dashboard or a panel is also told which other
dashboards a panel may [link](/guide/drilldown/) to
([#375](https://github.com/jbouder/holotable/issues/375)). The server lists
them for the caller, from the workspace the sources belong to, and only when
the caller may view that workspace. It lists the 30 most recently updated,
each with its id, its title clamped to 64 characters and the variables it
declares. In the editor, the dashboard being edited is marked, so a link back
to it is written as a self link.

The list goes into a fenced `DASHBOARDS` block after the catalog and the
workspace context, introduced as data like they are. The line that closes it
says the rules below win. Titles are people's text, so a title that reads like
an instruction is only a name. An explore panel writes no links and gets no list.

The rule the model is given is also enforced. A generated link whose
`dashboard` is not in the list fails validation on the server and in the
browser, which reads the same list from the response's `X-Link-Targets`
header. The one [automatic repair](/admin/ai-provider/#structured-output-repair)
then re-asks with the reason. A link target is always an id from the list
the server built, never a URL.

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

## Against a Prometheus source: the PromQL rules

A source's kind decides the language its panels are written in
([#387](https://github.com/jbouder/holotable/issues/387)). A generation over
TimescaleDB sources only is asked exactly what it always was. When a Prometheus
source is among the sources, the prompt changes in four ways:

- The catalog block lists the source's metrics with their type, help and labels.
  It never includes the URL or the auth mode.
- `PROMQL_RULES` follows the SQL rules, or replaces them when every source is
  Prometheus. It covers:
  - one expression per panel, in `query.promql`;
  - every selector naming a listed metric;
  - never `@` and never a time of the model's own;
  - `rate()` or `increase()` over a counter, with a range of a few scrape
    intervals;
  - `sum by (…)` to keep series few;
  - `histogram_quantile(0.95, sum by (le) (rate(x_bucket[5m])))` for
    percentiles;
  - `"instant": true` for a stat, gauge, pie, donut or table;
  - a variable only as a whole matcher value, `{host=":host"}`.
- Each panel kind's hint has a PromQL form where the SQL one talks about
  `timeField`. Heatmap, scatter and state timeline tell the model not to use them
  with a Prometheus source, because PromQL's rows are a time and one column per
  series.
- A `query` variable can list a label's values:
  `{"sourceId": …, "label": "instance", "match": "up{job=\"api\"}"}`.

With several sources of both kinds, a panel's language is its source's. The
schema the model is bound to says so too: a panel that writes `query.sql`
against a Prometheus source fails it, and the one
[repair](/admin/ai-provider/#structured-output-repair) tells the model to
write `query.promql` instead. The [PromQL guard](/concepts/executing-a-panel/#the-promql-guard)
is still the enforcement, on save and on every run.

Chat and the dashboard chat work the same way. On a dashboard with a
Prometheus source, the chat's `runQuery` tool takes `promql` (and `instant`)
beside `sql`, and the source's kind refuses the other language by name.

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
repair](/admin/ai-provider/#structured-output-repair)).

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
is written, one line says what is being composed (the same line Chat shows),
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
editor's NL edit and Chat keep separate lists — "make it a bar chart" is a
panel edit and is nonsense as a dashboard description.

The list lives in `localStorage` (`src/lib/prompt-history.ts`) and is never sent
anywhere: it is capped, expired, scoped to `(workspace, box)`, and read back as
untrusted. The durable record of what was asked is the **generation log**, which
stores a redacted prompt, a hash of the catalog that was in context and the spec
that came back, and is readable only by a workspace source-admin — see
[Data model](/architecture/data-model/).

## Chat

[Chat](/guide/chat/) is a conversation over a few sources in one workspace
(`src/lib/ai/data-chat.ts`, the routes under `/api/chat`). A turn is
`streamText` with two tools, both running on the server and both reaching a
source only through its kind's `check`, `plan` and `execute` under the
caller's row filter:

- **`runQuery`** fetches rows for the model to answer from, in words or a
  small table, exactly as the dashboard chat does.
- **`showPanel`** draws. The model writes a `ChatPanel`: an explore panel
  without the `id`, `layout` and window, which the server assigns. The server
  reads it through the IR, runs it once over the conversation's window, and
  streams the rows to the browser. Through `toModelOutput` the model is told
  only the columns, the row count and five sample rows, so it can narrate only
  what came back, at a bounded cost per panel. A spec that fails its schema is
  repaired once per turn; a statement the guard refuses is the tool's error,
  which the model may correct.

Every drawn spec, accepted or refused, is a generation in the log with
`mode: "chat"`, and every statement is audited as `query.execute` with
`via: "chat"`.

A kept conversation stores each message with every panel's rows stripped
(`persistableMessage` in `src/lib/chat/persist.ts`): the spec and the sample,
never the result. Reopening it runs each panel again through
`POST /api/chat/[id]/panels/[panelId]/run`, which takes a window and reads the
spec from the store, so the browser never sends a statement to run. The page
sends only the new question; the history the model sees is the stored one.

In the browser a panel is drawn by the dashboard's own `PanelView`, so every
panel kind can be an answer. **Show as** redraws the same rows as another kind
without a model call, each candidate checked against the IR's `Panel` first
(`src/lib/chat/view.ts`).

**Add to dashboard** saves the panel as shown, with the view applied. The
placement is arithmetic over the spec (`src/lib/panel-placement.ts`): the id
becomes a slug of the title, made unique within the dashboard, and the panel
lands at the bottom of the grid. The save is the ordinary
`PUT /api/dashboards/[id]` or `POST /api/dashboards`
(`src/lib/chat/add-to-dashboard.ts`), so the workspace is derived from the
trusted source records and every statement is checked again. A new dashboard
opens in the editor with `?panel=<id>` selected.

## Drafting a data source

`/api/sources/generate` applies the same shape to source registration: the model
emits only a validated `SourceDraft` — safe connection config plus a best-effort
table catalog and the `secret_ref` *name*. It is prompted to ignore any password
in the description, and it never emits a credential value. The user reviews the
draft, then runs **Test** and **Refresh** against the live database, which is the
source of truth for real columns.

## Dashboard chat

The chat beside a dashboard ([Dashboard chat](/guide/chat/#beside-a-dashboard)) is a
**read-only** assistant scoped to one dashboard (`src/lib/ai/chat.ts`,
`src/app/api/dashboards/[id]/chat/route.ts`). It reasons over the panel specs
first and may escalate to fetching fresh data through a guarded `runQuery`
tool.

The tool is scoped to the sources the dashboard already references *and* the
caller may use — each re-resolved and re-authorized, with unavailable ones
silently omitted, mirroring the poller's tombstone handling. It runs the same
`validateSql` → `buildExecutablePlan` → `executePlan` pipeline, injects the
time range **the reader is viewing**, caps rows (`MAX_TOOL_ROWS`) and
model-tool steps, and cannot mutate the dashboard. The model still authors SQL,
never data.

### Answers are about what is on screen

Each question carries the reader's view (#366), so the chat and the charts
cannot disagree about which window or which slice they mean:

- **The range.** The browser reads `from`/`to` from the URL `LiveDashboard`
  keeps on the window being viewed; none means the dashboard's own range. The
  route parses it as an IR time expression and resolves it on the server, the
  same as the stream; a range that does not resolve is a 400.
- **The variable picks.** The `var-*` values go through `checkedSelection`,
  the stream's allowlist, under the reader's row scope. A value the reader may
  not use does not fail the question: the turn runs with the defaults, and the
  prompt tells the model so. Values reach the prompt inside a fenced
  `VARIABLES` block, as untrusted text, and are still bound as parameters.
- **The panel asked about.** **Ask about this panel** sends only the panel's
  id; the server looks it up in the stored spec and ignores an id that is not
  on the dashboard. The browser never supplies SQL.

The route records the range, values and panel on the `dashboard.chat` audit
event, and each `runQuery` result reports the range and values it was narrowed
to, which the citation shows.

### What makes it usable

These make it usable rather than a demo (#82, #366):

- **History persists.** A dashboard's chat is the reader's own
  [Chat](#chat) conversation with that dashboard (#416): at most one per person
  per dashboard, stored in `conversation_messages` keyed by the SDK's own
  message id, so re-sending a turn updates the row rather than appending a
  duplicate. A conversation is one reader working something out, so it is
  scoped per person: two people on the same dashboard have separate histories
  and cannot see each other's. It is bounded by `CHAT_HISTORY_MAX_MESSAGES` and
  `CHAT_HISTORY_RETENTION_DAYS`, enforced on write *and* on read, so lowering
  either takes effect at once. The sweep runs in the same transaction as the
  write, so the table stays bounded without a scheduled job. Clearing the chat
  is a `DELETE` on the same route and deletes only the caller's own
  conversation. **Open in Chat** continues it on the Chat page, with the
  dashboard's panels in context.

  Stored rows are read back as untrusted: `content` is opaque JSONB holding a
  shape the SDK owns and evolves, so `parseStoredMessage` shape-checks each one
  and drops what no longer parses. A conversation that starts a turn shorter
  beats one that replays something half-understood into a prompt.

- **Answers cite their queries.** An assistant message that called `runQuery`
  renders an expandable "ran this query" footnote with the source id and the
  statement, plus the titles of any panels whose own query is the same
  statement. It is read off the message's own tool parts, which the SDK already
  streamed to the browser — no second request, and nothing the client is told
  that it was not already holding. The footnote names the range and variable
  values the server narrowed the rows to, rather than showing a statement that
  is neither what the model wrote nor what the database saw.

- **Answers are formatted.** Assistant text goes through the same sanitized
  Markdown subset a text panel uses (`src/lib/markdown.ts`): lists, emphasis,
  code and small tables, built as React elements, never an HTML string. A
  reader's own message stays plain text.

- **Suggestions are derived, not generated.** `chatSuggestions` builds three
  or four questions from the panel titles and viz kinds on the server;
  `panelChatSuggestions` does the same for the panel asked about. A second
  model call to decide what to ask a model would cost a round trip and a budget
  entry to produce three sentences, and would be different every time.

- **Stop actually stops.** The route passes the request's own `AbortSignal`
  into `streamText`, so a browser that presses stop cancels the provider call
  instead of leaving it generating — and billing — for an answer nobody is
  reading. `onEnd` still fires on that path, so the partial answer is stored.
