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
  executes **every panel once** via `makePanelExecutor`. For each panel it:
  1. **Re-resolves the source every tick.** If the source is missing,
     tombstoned, or belongs to a *different* workspace than the dashboard, it
     emits a `tombstone` event. All three cases look identical, so a crafted
     spec cannot probe for cross-workspace sources.
  2. Re-runs `validateSql`, builds the guarded plan, and executes it.
  3. **Computes a delta.** For time-series panels, `computeDelta` tracks the
     last emitted timestamp per panel and broadcasts only newer rows as an
     `append`. Non-time panels are sent as a full `replace` snapshot.

Events are broadcast to every subscriber's stream. The event types are `panel`
(`append`/`replace`), `panel-error`, `dashboard-error`, `tombstone`, and `tick`.

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
- `replace` swaps the window; `panel-error` and `tombstone` flip panel status.
- `dashboard-error` belongs to no panel: it renders as a banner above the grid,
  marks every panel stale, and clears on the next completed `tick`.
- A **staleness watchdog** marks panels `stale` if no `tick` arrives within
  roughly two refresh intervals, and on an `EventSource` transport error — which
  auto-reconnects.
- Each panel records **when its data arrived**; the status badge reports it, so
  panels that go stale independently can be told apart.

`PanelView` picks a renderer from `panel.viz`:

- `stat` → the last numeric value, run through `formatValue` per `panel.format`.
- `table` → an HTML table of the windowed rows.
- every other kind → `buildChartOption` (`src/components/charts/options.ts`)
  builds an ECharts option, drawn by `EChart`.

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
  colour painted behind it, since the canvas itself is transparent. Stat and
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
navigation posts to the same guarded `/api/sources/[id]/refresh` the source
list already uses, which checks `source:manage` for itself.

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
