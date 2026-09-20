---
title: How it works
description: The path from a prompt to a live chart, and where each stage lives in the code.
sidebar:
  order: 1
---

This section traces a single panel end to end: how it is **generated** by the
model, **validated** and **stored**, and finally **executed** and **rendered**
as a live chart. It is the narrative companion to
[Invariants](/architecture/invariants/), which lists the guarantees; here we
follow one panel through them.

```
                 author once                         replay forever
  ┌──────────────────────────────────┐   ┌──────────────────────────────────┐
  Prompt ─▶ /api/generate ─▶ LLM ─▶ IR spec ─▶ validate ─▶ Postgres (jsonb)
                                                                  │
                                                                  ▼
  Browser ◀─ ECharts merge ◀─ SSE ◀─ poller ◀─ guarded SQL ◀─ stored spec
```

## The whole trip, in one breath

1. A user describes what they want. `/api/generate` authorizes against the
   source's workspace and the model authors a **validated IR spec** — once.
2. On save, every panel's source and SQL are **re-validated**, the workspace is
   derived from trusted sources, and the spec is written as an **immutable,
   versioned** `jsonb` row.
3. To view, the browser opens **one SSE stream** and attaches to the **one
   shared poller** for that dashboard.
4. Each tick, the server re-resolves the source, re-validates the SQL, injects
   its **own time range** via bound parameters, and executes **read-only** SQL —
   producing the only real data in the system.
5. The poller broadcasts **deltas**; the browser **merges** them into a bounded
   window and ECharts updates in place.

The model designed the panel. The server, from then on, is the only thing that
ever runs it.

## Read it in order

1. [The shared IR](/concepts/the-shared-ir/) — the contract everything speaks.
2. [Generating a panel](/concepts/generating-a-panel/) — the model authors a spec.
3. [Executing a panel](/concepts/executing-a-panel/) — validation, storage, and the SQL guard.
4. [Streaming and rendering](/concepts/streaming-and-rendering/) — one poller, many viewers.

## Where to look in the code

| Stage | Files |
| --- | --- |
| IR contract | `src/lib/ir.ts` |
| Generate route + auth | `src/app/api/generate/route.ts` |
| LLM generation | `src/lib/ai/generate.ts`, `src/lib/ai/provider.ts` |
| Catalog (prompt metadata) | `src/lib/timescaledb/catalog.ts` |
| Save + validate | `src/app/api/dashboards/route.ts`, `src/lib/dashboard-service.ts` |
| SQL guard + time injection | `src/lib/sql/safety.ts` |
| Time resolution | `src/lib/time.ts` |
| Execution (read-only) | `src/lib/timescaledb/client.ts` |
| Poller + deltas | `src/lib/poller/registry.ts` |
| SSE stream | `src/app/api/dashboards/[id]/stream/route.ts` |
| Dashboard chat (read-only + `runQuery`) | `src/lib/ai/chat.ts`, `src/app/api/dashboards/[id]/chat/route.ts` |
| Live client | `src/components/dashboard/LiveDashboard.tsx`, `PanelView.tsx` |
| Charts | `src/components/charts/EChart.tsx`, `options.ts`, `src/lib/color/oklch.ts` |
