---
title: Writing specs with Claude Code
description: The /holotable skill writes, reviews and fixes dashboard specs from your terminal, without connecting to a server.
sidebar:
  order: 6
---

The repository ships a [Claude Code](https://claude.com/claude-code) skill,
`/holotable`, that knows the [spec format](/concepts/the-shared-ir/), every
[panel kind](/reference/visualization-types/) and the rules the
[SQL guard](/concepts/executing-a-panel/) enforces. Use it to draft a dashboard
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
| `references/sql-rules.md` | What the guard refuses, with the exact error text, and how the server injects the time window. |
| `references/guidance.md` | Which kind answers which question, measures, formats, thresholds, layout and naming. |
| `examples/` | A catalog, two complete dashboards using every kind and variables, and accepted and rejected SQL for each rule. |

## Why it stays correct

`test/holotable-skill.test.ts` runs under `npm test`. It imports every example
dashboard through the real export schema, runs every query in them and every
SQL example through the real guard against the example catalog (accepted ones
must pass, rejected ones must fail with the error the reference quotes), and
checks the reference's lists of panel kinds, value formats and color tokens
against the code. A change to the IR or the guard that the skill no longer
describes fails the build.

Connecting an agent to a running Holotable (listing sources, running a query,
saving a dashboard) is a separate piece of work: the MCP server,
[#148](https://github.com/jbouder/holotable/issues/148).
