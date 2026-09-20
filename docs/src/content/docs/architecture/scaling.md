---
title: Scaling and the poller
description: Why the poller is correct for one instance, what breaks with more, and what extraction would take.
sidebar:
  order: 3
---

The poller lives in the Node process (`src/lib/poller/registry.ts`). It is
correct and efficient for a **single app instance**: one poller per dashboard,
shared by all subscribers on that instance.

## What breaks with multiple replicas

Running multiple app replicas would create one poller **per replica**:

- duplicated polling load on TimescaleDB, multiplied by replica count
- no cross-instance delta sharing, so each replica keeps its own cursor
- subscribers on different replicas can see different data

`getPoller` keys pollers by `[dashboardId, timeRange.from, timeRange.to]` in a
process-local `Map`, so "one poller per dashboard" holds only *within* a
process.

## What extraction would take

To scale horizontally, the poller moves behind a shared runtime — a dedicated
poller service, or a pub/sub fan-out such as Redis — with web instances
subscribing rather than polling directly.

The code is already shaped for this: `computeDelta` is pure, and the
`PanelExecutor` abstraction is injectable, which is what makes the extraction
straightforward rather than a rewrite.

The open work, in order:

| Issue | Work |
| --- | --- |
| [#40](https://github.com/jbouder/holotable/issues/40) | Decide the topology — standalone service versus pub/sub fan-out |
| [#41](https://github.com/jbouder/holotable/issues/41) | Delta fan-out so replicas share one producer |
| [#42](https://github.com/jbouder/holotable/issues/42) | Distributed lease so exactly one process polls a dashboard |
| [#43](https://github.com/jbouder/holotable/issues/43) | SSE resume via `Last-Event-ID` |
| [#44](https://github.com/jbouder/holotable/issues/44) | Poller backoff and circuit breaker |

## Other known limits

- **No rate limiting** on the LLM routes yet
  ([#18](https://github.com/jbouder/holotable/issues/18)) — one editor can burn
  unbounded provider spend.
- **No subscriber caps** per dashboard or per instance
  ([#48](https://github.com/jbouder/holotable/issues/48)).
- **New connection per query.** `executePlan` opens a fresh `pg.Client` per
  execution with no pooling or concurrency ceiling
  ([#13](https://github.com/jbouder/holotable/issues/13)).
- **No published load numbers** yet
  ([#49](https://github.com/jbouder/holotable/issues/49)); the caveat above is
  qualitative until they exist.
