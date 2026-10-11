---
title: Sizing memory and pollers
description: How many live dashboards one instance can hold, from the rows each poller keeps to the memory limit the chart sets.
sidebar:
  order: 9
---

One instance runs one poller per dashboard and set of viewer picks
([Scaling](/architecture/scaling/)). Memory is what bounds how many pollers
it can hold, and this page is the arithmetic.

## What a poller holds

A poller keeps each panel's last result, so a viewer who joins is shown the
dashboard at once rather than after the next cycle. That is most of its heap.
Measured on a 20-panel dashboard of time series (#495):

| Rows per panel | Heap per poller |
| --- | --- |
| 720 | 1.6 MiB |
| 5,000 (`MAX_QUERY_ROWS`) | 10.7 MiB |

Viewers add little on top of that. A cycle is serialized once for everyone on
the same cursor, and each stream buffers at most 1 MiB before it counts as
behind ([Streaming](/concepts/streaming-and-rendering/#many-viewers-slow-viewers)).

## The heap and the cap

- **The heap ceiling.** The chart sets `NODE_OPTIONS=--max-old-space-size` to
  three quarters of `resources.limits.memory`, so under pressure V8 collects
  garbage instead of the kernel killing the pod. A limit below 256Mi fails
  the render. The image's own default, for `docker run`, is 768 MB, and the
  quick start's is 512 MB, because that container also runs Postgres.
- **The poller cap.** `MAX_POLLERS` is the most pollers one process runs.
  Left at `0`, it is half the heap ceiling over 11 MB, the worst case above:
  34 pollers at the chart's default 1Gi limit. A stream that would need one
  more poller is refused. The browser is told the server is at its limit and
  reconnects by itself a few seconds later, and other callers get `503` with
  `Retry-After`. Viewers of a running poller are never affected.

Two metrics show the headroom: `holotable_pollers_active` against
`holotable_pollers_limit` ([Metrics](/operations/metrics/)).

## Worked example

Take 50 dashboards of 20 panels at 720 rows each, every one with a different
time range or variable pick, so none share a poller. That needs 50 × 1.6 MiB,
which is 80 MiB of results, comfortably inside a 1Gi pod. At the 5,000-row cap
the same dashboards need 535 MiB. That is past the derived cap of 34 pollers,
so the 35th distinct dashboard waits. Raise `resources.limits.memory`, which
raises the heap and the derived cap with it, or set `MAX_POLLERS` explicitly
when the dashboards are known to be small.
