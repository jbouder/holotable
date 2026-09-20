---
title: Introduction
description: What Holotable is, what it deliberately does not do, and the one idea the whole design rests on.
sidebar:
  order: 1
---

Holotable turns a natural-language prompt into a live monitoring dashboard.

The one idea to hold onto: **the model authors a spec, never data.** A panel is
a small, validated description of *what to compute and how to draw it*. Real
metric values are only ever produced by the server executing guarded SQL against
TimescaleDB — at author time and on every refresh tick thereafter.

```
Prompt ─▶ /api/generate ─▶ LLM (streamObject) ─▶ Zod IR spec (validated)
                                                     │ save
                                             TimescaleDB (immutable versions)
Viewer ─▶ SSE /stream ─▶ shared in-process poller ─▶ guarded SQL ─▶ TimescaleDB
                                                     └─▶ deltas ─▶ ECharts merge
```

## The stack

Next.js 16 (App Router) · TypeScript · Tailwind v4 · Base UI · ECharts ·
TimescaleDB/PostgreSQL for both configuration and metrics · the Vercel AI SDK
(`streamObject` for specs, `streamText` with tool calls for chat) · Keycloak
OIDC with group-based authorization · Server-Sent Events.

## The contract

One shared Zod schema in `src/lib/ir.ts` is used by the model's output, the API
layer, persistence, and the client. There is exactly one definition, so the
contract cannot drift. See [The shared IR](/concepts/the-shared-ir/).

## What it deliberately does not do

- **The model never returns data.** It is structurally constrained by the output
  schema to emit a spec, and its output is re-parsed before it is trusted.
- **The model never chooses a time window.** It names a column; the server
  resolves and injects the bounds.
- **A dashboard never carries credentials.** Panels reference sources by an
  opaque id; credentials resolve from the server environment at execution time.
- **The LLM never runs on view or on a refresh tick.** Viewing replays a stored
  spec.

These are enforced, not aspirational — see [Invariants](/architecture/invariants/).

## Where to go next

- [Quick start](/getting-started/quick-start/) — run it with Docker or locally.
- [How it works](/concepts/how-it-works/) — the path from prompt to live chart.
- [Invariants](/architecture/invariants/) — the numbered guarantees the design rests on.
