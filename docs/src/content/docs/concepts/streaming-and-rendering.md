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
(`append`/`replace`), `panel-error`, `tombstone`, and `tick`.

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
- A **staleness watchdog** marks panels `stale` if no `tick` arrives within
  roughly two refresh intervals, and on an `EventSource` transport error — which
  auto-reconnects.

`PanelView` picks a renderer from `panel.viz`:

- `stat` → the last numeric value, run through `formatValue` per `panel.format`.
- `table` → an HTML table of the windowed rows.
- every other kind → `buildChartOption` (`src/components/charts/options.ts`)
  builds an ECharts option, drawn by `EChart`.

`EChart` is the invariant that keeps charts smooth: the ECharts instance is
created **once**, and every update is `setOption(option, { notMerge: false })`.
The chart **merges** incoming data into the existing series — it is never torn
down and recreated on a data tick, so streaming feels continuous.

## Pausing

The viewer can pause live updates. The Live/Pause toggle closes the
`EventSource`; resuming reattaches to the shared poller. While paused, the
transient `live` and `loading` badges are suppressed — they no longer reflect
reality — but error and tombstone states remain meaningful.

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
