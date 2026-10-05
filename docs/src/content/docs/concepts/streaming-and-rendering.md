---
title: Streaming and rendering
description: One poller per dashboard, delta cursors over SSE, and charts that merge rather than recreate.
sidebar:
  order: 5
---

## One poller, many viewers

Opening a dashboard authorizes `dashboard:view` and renders `LiveDashboard`,
which opens **exactly one** `EventSource` to `/api/dashboards/[id]/stream`.

Server side (`.../stream/route.ts` and `src/lib/poller/registry.ts`):

- The SSE handler re-authorizes the subscriber against the dashboard's workspace
  — SSE is cookie-authenticated — then attaches to the **shared poller** for
  that dashboard. `getPoller` guarantees **one poller per dashboard**, shared
  across all subscribers; a newer saved version replaces the old poller.
- Each tick (`max(minRefreshIntervalMs, spec.refreshIntervalMs)`), the poller
  executes **every panel once** via `makePanelExecutor`. A panel with a
  `refreshIntervalMs` of its own (#114) runs on that cadence instead, under
  the same floor. The poller keeps one timer and a due time per distinct
  cadence; when it fires, every cadence due within a quarter of its interval
  (at most a second) runs in the same cycle, so a 15-second and a 30-second
  panel make one cycle every 30 seconds, not two. A panel with its own
  `timeRange` is run over that window, resolved on the server like the
  dashboard's, and its `panel` frames carry the window they were selected
  over. For each panel it:
  1. **Re-resolves the source every tick.** If the source is missing,
     tombstoned, or belongs to a *different* workspace than the dashboard, it
     emits a `tombstone` event. All three cases look identical, so a crafted
     spec cannot probe for cross-workspace sources.
  2. Re-runs `validateSql`, builds the guarded plan, and executes it.
  3. **Remembers the result and computes each subscriber's delta.** The
     poller keeps every panel's last result. For a time-series panel each
     **subscriber** has its own cursor (the newest timestamp it has been
     sent), and `computeDelta` sends it the rows from that timestamp on as
     an `append` carrying `since`. The browser drops what it holds from
     `since` and puts these in its place, so the newest bucket of a series,
     still filling, is updated rather than frozen at its first value.
     Non-time panels are sent as a full `replace` snapshot.

Events go to every subscriber's stream. The event types are `panel`
(`append`/`replace`), `panel-error`, `panel-degraded`, `dashboard-error`,
`tombstone`, and `tick`, plus the per-stream `session-expired`,
`session-ended` and `access-ended` described below.

### When a panel keeps failing

A failed execution used to be retried on the next tick, forever. A source
that was down, or a statement that always timed out, was hit again every
refresh by every dashboard showing it. The poller now counts each panel's
consecutive failures (`src/lib/poller/backoff.ts`):

- **Under `POLLER_FAILURE_THRESHOLD`** (default 3), nothing changes. The
  failure is a `panel-error` and the next tick tries again, so a single blip
  costs one refresh.
- **From the threshold on**, the panel sits out until its `retryAt`. The wait
  is twice the refresh interval and doubles with each further failure, up to
  `POLLER_MAX_BACKOFF_MS` (default 5 minutes): 30s, 60s, 120s, 240s, then 5
  minutes on a fifteen-second dashboard. The viewer gets a `panel-degraded`
  frame with the error, the count and `retryAt`, and the panel shows when it
  is tried next.
- **One success clears it**, and the panel is back on the refresh interval at
  once.

Only failures that reached the source count. A statement the guard refuses or
a missing row-filter claim never runs, so it puts no load on the source to
back off from.

**Retry now** on a degraded panel posts to
`/api/dashboards/[id]/panels/[panelId]/retry`, which runs it at once on every
poller showing the dashboard. The poller ignores a retry within
`MIN_REFRESH_INTERVAL_MS` of the panel's last attempt, and a failed retry
counts like any other failure, so the button can't run a failing statement
faster than a refresh would.

The state is per panel, per poller. Two dashboards on the same failing source
each back off on their own. A source-wide breaker would stop a down source
being tried by every panel that reads it, and is a follow-up if it turns out
to be needed.

### Joining and resuming

A subscriber that joins a poller already running — a second viewer, or a
reconnect while someone else is watching — is caught up at once from the
poller's last results: a `replace` per panel and the last `tick`, without
waiting for the next cycle (#43).

Each time-series frame carries an SSE `id:`, the subscriber's cursors and the
spec version (`src/lib/poller/resume.ts`). `EventSource` sends the last one
back as `Last-Event-ID` when it reconnects by itself; `LiveDashboard` passes it
as `?lastEventId=` when it builds a new `EventSource` for the same window (a
manual Reconnect, a tab shown again). The subscriber then gets only the rows
it missed, and the panels keep their history. An id from another spec version,
or one that does not decode, is ignored and the subscriber gets a full
snapshot. The id is not trusted: the worst a forged one can do is ask for rows
the viewer could already see.

The stream also sends a comment every 15 seconds, so a proxy that closes quiet
connections does not close one whose dashboard refreshes slowly.

### How long a stream stays authorized

The handler authorizes a subscriber when it connects, and the response then
stays open. So that one check cannot outlive the session it was made with,
each stream is guarded by the token it was opened with
(`src/lib/auth/stream-guard.ts`, #32), and ended with a named event:

| Event | When | The browser |
| --- | --- | --- |
| `session-expired` | the token reaches its `exp` | reconnects with its last event id, renewing first unless another tab already has |
| `session-ended` | the realm ends the session (#28) | tries one renewal, which is refused, and the sign-in banner appears |
| `access-ended` | a re-check finds the dashboard deleted, or no longer in the viewer's workspaces | stops and says so above the grid |

The re-check runs every `SSE_REAUTH_INTERVAL_MS` (default 60s): it verifies
the token again and re-authorizes `dashboard:view` against the dashboard as it
is now. A database error during it keeps the stream and tries again next time.

A stream cannot see the browser's newer cookie, so expiry ends it rather than
extending it. The reconnect is cheap — it resumes, and the panels never go
stale — and it is authorized from the renewed token, which is how a group the
realm removed reaches an open stream: within one session-token lifetime, half
the realm's refresh lifetime (#27). Only the one subscriber is closed; the
others on the same poller carry on.

A `tick` is sent only when the whole cycle completed. A cycle that failed
before the panels — an unresolvable time range, say — sends a
`dashboard-error` instead, the poller reschedules anyway, and the viewer shows
the failure above the grid rather than a Live badge over frozen charts.

:::caution[Single-instance caveat]
The poller lives in the Node process, so it is correct for a *single* app
instance. Multiple replicas would each run their own poller. See
[Scaling and the poller](/architecture/scaling/).
:::

## Merge, never recreate

Client side (`LiveDashboard.tsx` → `PanelView.tsx` → `EChart.tsx`):

`LiveDashboard` fans SSE events out to per-panel React state:

- `append` rows are concatenated into a **bounded rolling window**
  (`MAX_WINDOW_POINTS`, default 720) — old points fall off the front.
- `replace` swaps the window; `panel-error`, `panel-degraded` and `tombstone`
  flip panel status.
- `dashboard-error` belongs to no panel: it renders as a banner above the grid,
  marks every panel stale, and clears on the next completed `tick`.
- A **staleness watchdog** marks panels `stale` if no `tick` arrives within
  roughly two cycles (the fastest panel's cadence, `cycleMs`), and on an `EventSource` transport error — which
  auto-reconnects and resumes.
- Panels are cleared only when a stream starts over (first load, or a new time
  window). A resumed stream keeps them.
- Each panel records **when its data arrived**; the status badge reports it, so
  panels that go stale independently can be told apart.

`PanelView` looks `panel.viz` up in the panel registry and draws what it
finds:

- `stat` → the last numeric value, run through `formatValue` per `panel.format`.
- `table` → an HTML table of the windowed rows.
- `text` → the panel's Markdown, rendered into React elements by
  `src/lib/markdown.ts` (never as an HTML string). It runs no query.
- every other kind → the kind's option builder (`src/components/charts/options.ts`)
  makes an ECharts option, drawn by `EChart`.

## Panel kinds

The kinds a panel can be are registered in one list,
`PANEL_KINDS` in `src/lib/panels/registry.ts` (#61). Each kind is a small
module under `src/lib/panels/kinds/` that says, in plain data:

| Field | Used by |
| --- | --- |
| `kind` | `panel.viz`. `VizType` in `src/lib/ir.ts` is built from the registered names, so an unregistered one fails validation with the list of valid kinds. |
| `summary` | The [Visualization types](/reference/visualization-types/) reference, generated from it. |
| `promptHint` | The generation prompt, whose list of kinds is built from the hints. |
| `canvas` | PNG export, and whether the explore page plots the panel. |
| `timeBrush` | Whether a drag across the chart selects a time range. |
| `skeleton` | The shape the panel shows while it loads. |
| `query` | `"required"`, or `"none"` for a kind that runs nothing (text). The IR holds the panel to it, and code that executes or lists queries filters through `hasQuery`. |
| `requiresTimeField` | The IR refuses the panel without `query.timeField` (state timeline). |
| `options` | The kind's own options schema, which `panel.options` is validated against. See [Panel options](/reference/panel-options/). |
| `starterOptions` | What a panel switched to this kind in the editor starts with, when `{}` would not do. |

How a kind is drawn is the browser half, `PANEL_RENDERERS` in
`src/components/panels/registry.ts`: either `{ type: "chart", option, shape? }`,
an ECharts option builder, or `{ type: "html", Body }`, a component. An option
builder is given the rows and a context: the viewer's time display, and the
window the server resolved for the rows (sent with every `tick`, and returned
by `/api/query`), so a chart that runs to "now" ends where the server's window
does. `shape` names a layout of the kind, such as a gauge's dial or bars.
`PanelView` keys the chart by it, so switching layouts remounts the chart.
Data updates never change it, so they still merge (invariant 11). It is kept
apart because `src/lib/ir.ts` imports the registry, and the server and the
prompt must not pull React in with it. The renderer map is typed as
`Record<VizType, PanelRenderer>`, so a kind registered without a renderer does
not compile.

Adding a kind is therefore:

1. a module under `src/lib/panels/kinds/` and one line in `PANEL_KINDS`;
2. its renderer (an option builder, or a component under
   `src/components/panels/`) and one line in `PANEL_RENDERERS`.

Registration is an import. Nothing is loaded at runtime, so there is no way
for a request to add a kind.

A new kind is an additive change to the IR: every spec saved before it still
parses, so it needs no `specVersion` bump (see
[invariant 3](/architecture/invariants/)). Renaming or removing a kind does
need one, with an upgrader that rewrites the old name.

`EChart` is the invariant that keeps charts smooth: the ECharts instance is
created **once**, and every update is `setOption(option, { notMerge: false })`.
The chart **merges** incoming data into the existing series — it is never torn
down and recreated on a data tick, so streaming feels continuous.

## Connection state

`EventSource` retries forever and says nothing about it, so a dead stream and a
slow one look the same. `LiveDashboard` therefore tracks the connection
separately from panel data, through the reducer in `src/lib/connection.ts`:
`connecting` → `live` → `reconnecting` → `failed`, plus `paused`.

The header indicator shows that state, names the attempt while reconnecting,
and reports how long ago data last arrived — counting up for the first minute,
then an absolute clock time. Once the automatic retries have failed
`MANUAL_RECONNECT_AFTER_ATTEMPTS` times, or the browser gives up outright
(`readyState === CLOSED`, typically an expired session), a manual **Reconnect**
appears; it replaces the `EventSource`, which is the only way to shortcut the
browser's own retry schedule. The whole indicator is one polite `aria-live`
region carrying a full sentence, so a state change is announced rather than a
stream of counting seconds.

A reopened socket does **not** reset the freshness clock: it answers "how old
is this number", not "how old is this connection".

## Choosing the window

The header's time picker offers three ways to say the same thing, plus shift
and zoom over whatever is currently chosen:

- **Quick ranges** — the five presets (15m … 7d), all relative to `now`.
- **Last N** — a custom relative width in minutes, hours, days or weeks.
- **Absolute** — two `datetime-local` instants, entered and displayed in the
  reader's own zone and stored as UTC ISO-8601.
- **Shift back / forward** moves the window by its own width; **zoom out**
  doubles it. Shifting forward past `now` snaps back to the rolling window of
  the same width, which is how a reader who went looking at yesterday returns
  to live.
- **Brushing** a line, area or bar panel that has a `timeField` selects the
  stretch of time the drag covered and makes it the dashboard's window.
  `brushedRange` reads the timestamps of the first and last rows the selection
  covered; a selection it cannot read leaves the window alone rather than
  guessing at one. Only kinds whose registry entry sets `timeBrush` (line,
  area and bar) are brushable; on the rest the x-axis is not time laid out
  left to right, or there is no axis at all.
- Panels on one dashboard share a **crosshair**: moving the pointer over one
  chart moves the axis pointer on the others. This is done by forwarding the
  hovered category index between the instances, not with `echarts.connect`,
  which mirrors *every* connected action — a brush included — and would make
  one drag produce a selection on every panel.

Everything the picker emits is a pair of IR `TimeExpr` strings. The client is
never the authority on the window that was queried: the expressions go out on
the stream URL, the route re-parses them against `TimeRange`, and the poller
calls `resolveTimeRange` itself on every tick (invariant 4). A window that
`TimeRange` refuses is a `400` on the stream and falls back to the dashboard's
own range on the page.

An **absolute** window is frozen by definition — the poller keeps ticking, but
it re-queries the same seconds — so the picker badges it *Fixed range* and
offers a way back, and the staleness watchdog is switched off for it. "No new
data" is the correct state there, not a stale one.

The chosen window is written into the URL with `history.replaceState`, so a
range is a link someone can send. It is `replaceState` and not a Next
navigation because re-rendering the server page would remount the viewer and
tear down the `EventSource` on every change. The dashboard's own range is left
out of the query string, so the default link stays clean.

## Pausing

The viewer can pause live updates. The Pause/Resume toggle closes the
`EventSource`; resuming reattaches to the shared poller. While paused, the
transient `live` and `loading` badges are suppressed — they no longer reflect
reality — but error and tombstone states remain meaningful. Paused reads as a
distinct, muted state in the indicator; it is not the same thing as a dropped
stream.

## Fullscreen and export

Each panel's header carries an overflow menu with three local actions (#76):

- **Fullscreen** expands the panel over the viewport. It is not a portal: the
  same card simply becomes `fixed`, so the panel's position in the React tree
  never changes and the ECharts instance is *resized* by the `ResizeObserver`
  already in `EChart` rather than disposed and rebuilt. Escape closes it and
  focus returns to whatever opened it.
- **Export CSV** serializes the window the panel is currently holding — RFC
  4180 quoting, CRLF, a UTF-8 BOM so Excel reads it as UTF-8. A *text* cell
  that starts with `=`, `+`, `-`, `@` or a tab is prefixed with an apostrophe,
  because a spreadsheet would otherwise run it as a formula and the values come
  from a database Holotable does not own. Numbers are never touched.
- **Export PNG** comes out of the ECharts instance with the theme's surface
  color painted behind it, since the canvas itself is transparent. Stat and
  table panels are offered the CSV alone.

None of the three asks the server for anything. An export therefore cannot
contain a row the panel was not already showing, and cannot become a second,
unguarded way to run a query. Exporting the **full** result set server-side is
a different feature and is not this one.

## Getting around: Cmd/Ctrl+K

`CommandPalette` (`src/components/command-palette.tsx`) is mounted in the root
layout for a signed-in identity and opens anywhere in the app. It lists
dashboards, data sources, the app's pages, and a handful of actions — new
dashboard, new source, the theme, and a catalog refresh for a source the caller
administers.

It is a navigator, not a second API surface. Results come from
`GET /api/search`, whose candidate workspaces come from the validated claims:
there is no workspace parameter, so nothing in the query string can widen what
comes back, and a result is by construction somewhere the identity could
already go. A source is projected to its id, name and workspace —
`SourceRecord` carries the connection config and the catalog, and neither has
any business in a search result (invariant 5). The one action that is not
navigation opens the same reviewed refresh the source list uses: a diff from
the guarded `/api/sources/[id]/refresh`, and nothing written until it is
applied. The route checks `source:manage` for itself.

Matching and ordering live in `src/lib/command-palette.ts` as pure functions
over a payload and a query, which is what makes them testable. Actions are
*data* — a tagged union the component switches on — rather than callbacks, so a
command can be ranked, compared and remembered. Recently-used commands are kept
in `localStorage` and lead the list before anything is typed; once something is
typed the score decides and recency only breaks ties. A remembered id is
treated as untrusted: it can name a command, never reach one.

The listbox follows the APG combobox pattern rather than a menu — real focus
stays in the text field and `aria-activedescendant` points at the selection —
because a menu would move focus out of the box being typed into.

## A rendering detail worth knowing

Design tokens are authored in **OKLCH**, but ECharts cannot parse `oklch()`.
`chartPalette()` (`src/lib/color/oklch.ts`) resolves tokens to RGB/hex before
they reach any chart option.

## Dashboard chat

The viewer also includes a **read-only** chat assistant scoped to one dashboard.
It reasons over the panel specs first and may escalate to fetching fresh data
through a guarded `runQuery` tool.

The tool is scoped to the sources the dashboard already references *and* the
caller may use — each re-resolved and re-authorized, with unavailable ones
silently omitted, mirroring the poller's tombstone handling. It runs the same
`validateSql` → `buildExecutablePlan` → `executePlan` pipeline, injects the
**dashboard's own** time range, caps rows (`MAX_TOOL_ROWS`) and model-tool
steps, and cannot mutate the dashboard. The model still authors SQL, never data.

Four things make it usable rather than a demo (#82):

- **History persists.** A turn is stored in `chat_messages`, keyed by
  `(dashboard_id, user_sub, id)` — the SDK's own message id, so re-sending a
  turn updates the row rather than appending a duplicate. A conversation is one
  reader working something out, so it is scoped per person: two people on the
  same dashboard have separate histories and cannot see each other's. It is
  bounded by `CHAT_HISTORY_MAX_MESSAGES` and `CHAT_HISTORY_RETENTION_DAYS`,
  enforced on write *and* on read, so lowering either takes effect at once
  rather than whenever someone next sends a message. The sweep runs in the same
  transaction as the write, which is what keeps the table bounded without a
  scheduled job. Clearing the chat is a `DELETE` on the same route, and forgets
  only the caller's own conversation.

  Stored rows are read back as untrusted: `content` is opaque JSONB holding a
  shape the SDK owns and evolves, so `parseStoredMessage` shape-checks each one
  and drops what no longer parses. A conversation that starts a turn shorter
  beats one that replays something half-understood into a prompt.

- **Answers cite their queries.** An assistant message that called `runQuery`
  renders an expandable "ran this query" footnote with the source id and the
  statement, plus the titles of any panels whose own query is the same
  statement. It is read off the message's own tool parts, which the SDK already
  streamed to the browser — no second request, and nothing the client is told
  that it was not already holding. The footnote says the server added the
  time-range predicate rather than showing a statement that is neither what the
  model wrote nor what the database saw.

- **Follow-up chips are derived, not generated.** `chatSuggestions` builds three
  or four questions from the panel titles and viz kinds on the server. A second
  model call to decide what to ask a model would cost a round trip and a budget
  entry to produce three sentences, and would be different every time.

- **Stop actually stops.** The route passes the request's own `AbortSignal` into
  `streamText`, so a browser that presses stop cancels the provider call instead
  of leaving it generating — and billing — for an answer nobody is reading.
  `onEnd` still fires on that path, so the partial answer is stored.
