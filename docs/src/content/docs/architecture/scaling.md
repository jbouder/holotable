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

`getPoller` keys pollers by `[dashboardId, timeRange.from, timeRange.to]` in a
process-local `Map`, so "one poller per dashboard" holds only *within* a
process.

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
- **Idle viewers.** A hidden tab closes its stream after a grace period
  (`src/lib/stream-idle.ts`), and a poller with no subscribers stops.
- **The public demo** sits behind a Worker with per-IP limits
  (`deploy/cloudflare/demo/`).

## Open work that matters on one instance

| Issue | Work |
| --- | --- |
| [#44](https://github.com/jbouder/holotable/issues/44) | Poller backoff and a circuit breaker, so a down source is not re-hit every tick |
