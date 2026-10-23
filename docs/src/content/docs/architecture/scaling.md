---
title: Scaling and the poller
description: Why Holotable runs as one instance by design, what breaks with more, and what extraction would take if it is ever needed.
sidebar:
  order: 3
---

Holotable runs as a **single app instance by design**. The poller lives in the
Node process (`src/lib/poller/registry.ts`). It is correct and efficient for one
instance: one poller per dashboard, shared by every subscriber on that
instance. The Helm chart defaults to `replicaCount: 1` with autoscaling off,
and that is the supported topology, not a stopgap.

Multi-instance work (a pub/sub fan-out, a distributed lease, cross-dashboard
query dedupe, load-test numbers to size it) was planned and then dropped as
premature. Nothing about the current workload needs it, and each piece adds a
moving part next to the security checks. It comes back when a real deployment
outgrows one instance, with numbers from that deployment.

## What breaks with multiple replicas

Running multiple app replicas would create one poller **per replica**:

- duplicated polling load on TimescaleDB, multiplied by replica count
- no cross-instance delta sharing, so each replica keeps its own cursor
- subscribers on different replicas can see different data

`getPoller` keys pollers by the dashboard id, its time range, the viewer's
row-filter claim values and the picked variable values, in a process-local
`Map`, so "one poller per dashboard" holds only *within* a process.

## What extraction would take

To scale horizontally, the poller would move behind a shared runtime: a
dedicated poller service, or a pub/sub fan-out such as Redis, with web
instances subscribing rather than polling directly.

The code is already shaped for this. `computeDelta` is pure and the
`PanelExecutor` abstraction is injectable, which keeps an extraction a move
rather than a rewrite.

## Load already bounded on one instance

- **LLM spend.** The generation and chat routes are rate limited and budgeted
  per workspace (`src/lib/limits/llm.ts`).
- **Connections to a metrics source.** Each source has one pool
  (`src/lib/timescaledb/pool.ts`) of at most `MAX_POOL_PER_SOURCE`
  connections (default 5), reused across ticks. A busy dashboard waits for a
  free connection rather than opening more, so it cannot use up the metrics
  database's `max_connections` on its own.
- **Poller executions per source** (#487). Pollers hold at most
  `MAX_POOL_PER_SOURCE - 1` executions on one source at once
  (`src/lib/poller/source-slots.ts`), so Chat, a preview or `/api/query`
  always finds a connection. A panel waits up to half its interval for a
  slot. If none frees in time, the panel is skipped for that cycle and shows
  **waiting**, with its last rows kept. A checkout that timed out in a full
  pool is treated the same way. Neither is a failure, so neither starts the
  backoff below. Each cycle reads each source record from the config
  database once, however many panels use it, and re-checks the workspace for
  every panel. A new poller's second cycle is pushed back by up to half its
  interval, so dashboards opened together stop polling together.

  The arithmetic: one source sustains about `slots ÷ query time` executions a
  second, which is 4 ÷ 0.1 s = 40/s at the defaults and 100 ms queries.
  Dashboards ask for `panels ÷ interval` executions a second each, so 20
  dashboards of 20 panels at 15 s ask for about 27/s and fit. 100 such
  dashboards ask for 133/s and do not. Their panels wait and refresh less
  often, but none of them fails. Raise `MAX_POOL_PER_SOURCE` only as far as
  the metrics database's `max_connections` allows across every instance.
- **Panels that keep failing.** After `POLLER_FAILURE_THRESHOLD` failures in
  a row (default 3), a panel stops running on every tick and backs off,
  doubling from the refresh interval up to `POLLER_MAX_BACKOFF_MS` (default 5
  minutes). A source that is down is tried a few times an hour, not every
  fifteen seconds. See
  [Streaming and rendering](/concepts/streaming-and-rendering/#when-a-panel-keeps-failing).
- **Idle viewers.** A hidden tab closes its stream after a grace period
  (`src/lib/stream-idle.ts`), and a poller with no subscribers stops.
- **The public demo** sits behind a Worker with per-IP limits
  (`deploy/cloudflare/demo/`).

## Drawing large series

Past `LARGE_SERIES_POINTS` (500) points per series, `src/components/charts/options.ts`
makes a series cheap to paint (#491). A line or area is sampled with
largest-triangle-three-buckets, and a `"smooth"` one is drawn straight (a
step stays a step, and straight is the default, #665). Bars and scatter use
ECharts' large mode. `animationThreshold` stops a series that long from
animating. The motion preference still turns animation off below it, because
`EChart` applies it and the builders never turn animation on. At or under the
threshold the option is unchanged. The accessible table beside a chart lists
the panel's own rows, never the sampled ones.

A click on a sampled series reports its index among the points ECharts kept.
`EChart` maps it back to the series' raw index before the datum is read, so a
drilldown resolves the row that was clicked.

**The x axis stays a category axis.** Three things depend on it. The brush
maps its span to row indices (`brushedRange`). The crosshair group moves its
peers by index. A datum click reads the row at its index. Sampling keeps all
three working, because the category axis still holds every row's label. A
time axis would need each of them to work by timestamp instead. It would also
change how a series with gaps is drawn. That is a separate change, if a panel
ever needs it.

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
