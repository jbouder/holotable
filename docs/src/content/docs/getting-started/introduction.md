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

That spec is the **IR**, short for *intermediate representation*: the format
that sits between the prompt and the rendered dashboard, the way a compiler's
IR sits between source and machine code. The rest of these docs call it the IR.

One shared Zod schema in `src/lib/ir.ts` defines it, and it is used by the
model's output, the API layer, persistence, and the client. There is exactly one definition, so the
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
- [Your first dashboard](/getting-started/your-first-dashboard/) — the three
  steps from an empty install to a live dashboard over your own database.
- [Viewing a dashboard](/guide/viewing-a-dashboard/) and
  [Editing a dashboard](/guide/editing-a-dashboard/) — the user guide.
- [How it works](/concepts/how-it-works/) — the path from prompt to live chart.
- [Invariants](/architecture/invariants/) — the numbered guarantees the design rests on.

## Where each topic lives

This site is the canonical explanation of every feature. A few documents live
in the repository instead, and each is the one place its topic is kept:

- [`SECURITY.md`](https://github.com/jbouder/holotable/blob/main/SECURITY.md) —
  the trust model, the known limitations, and how to report a vulnerability.
  [Invariants](/architecture/invariants/) is where each boundary is enforced.
- [`CONTRIBUTING.md`](https://github.com/jbouder/holotable/blob/main/CONTRIBUTING.md) —
  local setup, the checks, conventions, and which pages a change must update.
- [`AGENTS.md`](https://github.com/jbouder/holotable/blob/main/AGENTS.md) — the
  same conventions in more detail, written for coding agents.
- The [Helm chart README](https://github.com/jbouder/holotable/tree/main/deploy/helm/holotable) —
  every chart value. [Deploying on Kubernetes](/operations/kubernetes/) is the
  reasoning behind them.
