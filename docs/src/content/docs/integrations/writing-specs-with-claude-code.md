---
title: Writing specs with Claude Code
description: The /holotable skill writes, reviews and fixes dashboard specs from your terminal, without connecting to a server.
sidebar:
  order: 6
---

The repository ships a [Claude Code](https://claude.com/claude-code) skill,
`/holotable`, that knows the [spec format](/concepts/the-shared-ir/), every
[panel kind](/reference/visualization-types/) and the rules the
[SQL, PromQL and LogQL guards](/concepts/executing-a-panel/) enforce. Use it to draft a dashboard
next to the code and schema it monitors, to review a spec in a pull request, or
to understand why an import was refused.

It is **knowledge only**. It never calls a Holotable server, signs in, or needs
a connection string or password; a spec refers to its data by an opaque source
id and nothing else. What it produces you import yourself.

## Using it

Open Claude Code in a checkout of this repository (the skill lives in
`.claude/skills/holotable/`) and ask, or type `/holotable`:

- *"Write a dashboard for the checkout service: traffic, error rate, p95
  latency. Here are my tables: …"* Paste the tables and columns, or point at
  a schema file. The source id and the catalog browser on the **Data sources**
  page show what the source exposes.
- *"Same, but it's in Prometheus. Here are the metrics and their labels: …"*
  The skill asks which kind the source is first, and writes PromQL for a
  Prometheus source: rated counters, `instant` for a stat or a table, and
  label-values variables.
- *"And the API's logs are in Loki, with labels `app`, `env` and `level`."*
  For a Loki source it writes LogQL: a log query for a `logs` panel, with
  `options.limit` and `options.level`, and a metric query such as
  `sum by (level) (count_over_time({app="api"} [1m]))` for every other kind.
- *"Review this spec"*, with a file or a pasted export.
- *"Import said `panels.3.query.sql: table not in catalog allowlist:
  public.events`. Why?"*

It answers with a dashboard export file. Import it from **Dashboards →
Import**, map its source id to one of your sources, and the app validates it
again, schema and SQL, before anything runs.

## What it knows

| File | What it covers |
|---|---|
| `SKILL.md` | The three workflows: write, review, explain a rejection. |
| `references/ir.md` | Every field, its type and bounds, the import wrapper, time expressions, variables, layout. |
| `references/panel-kinds.md` | Each `viz` kind, the result shape its query returns, and its options. |
| `references/sql-rules.md` | What the SQL guard refuses, with the exact error text, and how the server injects the time window. |
| `references/promql-rules.md` | What the PromQL guard refuses and hints at, with the exact text, how the server picks the step, `instant` and `minStep`, and variables as matcher values. |
| `references/logql-rules.md` | What the LogQL guard refuses, with the exact text: selectors anchored with `=` on a listed label, allowlisted stages and functions, `offset` capped, variables only as matcher values or line-filter strings. Which panel takes a log query and which a metric query, and `instant` only for a metric query. |
| `references/guidance.md` | Which kind answers which question, measures, formats, thresholds, layout and naming. |
| `examples/` | A SQL catalog, two complete dashboards using every kind and variables, and accepted and rejected SQL for each rule; a Prometheus metric catalog, a complete PromQL dashboard with a label-values variable, and accepted and rejected PromQL for each rule; a Loki label catalog, a complete LogQL dashboard, and accepted and rejected LogQL for each rule. |

## Why it stays correct

`test/holotable-skill.test.ts` runs under `npm test`. It imports every example
dashboard through the real export schema, runs every query in them and every
SQL, PromQL and LogQL example through the real guard against its example catalog
(accepted ones must pass, rejected ones must fail with the error the reference
quotes, and every error in the PromQL and LogQL rules tables must come from one), and
checks the reference's lists of panel kinds, value formats and color tokens
against the code. A change to the IR or the guard that the skill no longer
describes fails the build.

Connecting an agent to a running Holotable — listing sources, validating and
running a query, saving a dashboard — is the [MCP server](/integrations/mcp/),
which the same client reaches at `/api/mcp` after signing in to the realm.
