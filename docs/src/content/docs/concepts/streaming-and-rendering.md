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

## A rendering detail worth knowing

Design tokens are authored in **OKLCH**, but ECharts cannot parse `oklch()`.
`chartPalette()` (`src/lib/color/oklch.ts`) resolves tokens to RGB/hex before
they reach any chart option.

What the viewer does with the stream once it arrives — the time picker, pausing,
fullscreen, exports, the command palette and the dashboard chat — is
[Viewing a dashboard](/guide/viewing-a-dashboard/).
