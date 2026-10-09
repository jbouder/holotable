---
title: "ADR 2: Source kinds"
description: Why a second kind of source is a registered module rather than a kind switch, why the config discriminator is defaulted, and why the query language belongs to the source.
---

- **Status:** accepted, 2026-10-09
- **Issue:** [#382](https://github.com/jbouder/holotable/issues/382), phase 1 of [#381](https://github.com/jbouder/holotable/issues/381)
- **Changes:** none of the invariants. It gives
  [invariant 7](/architecture/invariants/#7-all-model-sql-is-untrusted)'s
  "future driver" a place to live.

## Context

A source has had a `kind` column since the first migration, with one value,
`timescaledb`, that nothing read. Everything a source does lived under
`src/lib/timescaledb/` and was imported by name: execution from the poller,
`/api/query`, chat, variables and the MCP tools; discovery, refresh and the
connection test from the source routes; the catalog prompt from generation.

Reading Prometheus ([#381](https://github.com/jbouder/holotable/issues/381))
needs a second kind. Added by hand, it would be a `switch (source.kind)` in
each of those places, and the next kind another case in each. That is what
the panel registry ([#61](https://github.com/jbouder/holotable/issues/61))
stopped for panel kinds, for the same reasons: a missed case fails at
runtime, not at compile time, and nothing lists what a kind must provide.

## Options

1. **A `kind` switch at each call site.** Smallest first step. Every new
   kind touches every consumer, and nothing fails when one is forgotten.
2. **A registry of kind modules.** Each kind declares what it is and how it
   is reached; consumers ask the source for its kind and use what comes back.
3. **A plugin interface loaded at runtime.** The most open. It moves the
   trust boundary to code nobody has reviewed with the guard, which is the
   wrong trade for the part of the system that executes untrusted queries.

## Decision

**Option 2.** `src/lib/sources/registry.ts` lists the kinds;
`src/lib/sources/kinds/timescaledb.ts` is the first. Registering a kind is an
import, never a lookup by a string a request supplied.

A kind declares, in its browser-safe module:

- `kind`, the stored value of `sources.kind`, which is never renamed;
- `config`, its strict Zod schema, catalog and row filter included;
- `connection`, `catalog` and `listing`, the projections of a source that
  exist today, each an explicit list of fields;
- `language`, the query language a panel against it carries.

Its server half, under `src/lib/sources/server/`, holds what the browser must
never reach: `discover`, `refresh`, `test`, `validate`, `plan`, `execute`,
`session`, `renderCatalog`, `catalogPrompt`, `dispose` and `closeAll`. The
two are split the way `secrets/credentials.ts` and `secret-refs.ts` are. A
mapped type makes a kind without a server half a compile error, and
`test/source-kinds.test.ts` fails on a kind comparison or a
`src/lib/timescaledb/` import outside `src/lib/sources/`.

**The discriminator is defaulted, not migrated.** `SourceConfig` is a
discriminated union on `kind`. The TimescaleDB branch reads a missing `kind`
as `timescaledb`, so every config stored before the union parses unchanged,
and the repository writes `kind` into both the column and the JSONB from the
one value on the next save, so the two cannot disagree. A stored row whose
column names an unknown kind, or whose config names a different one, fails to
load with a message naming it, as an unknown `specVersion` does. No other
kind may default its discriminator: a config that does not say what it is has
exactly one reading, the one it was written as.

**The language belongs to the source kind, not the panel kind.** A time
series can be drawn from SQL or from PromQL; what decides which one a panel
carries is what its source can answer. Putting the language on the panel kind
would multiply every panel kind by every language, and let a panel name a
language its source cannot run.

## Consequences

- Phase 1 changes no behavior. The guard, the planner and the executor are
  the same functions, reached through the kind; the fuzz suite and the SQL
  safety tests run unchanged, and the IR does not change.
- A new kind is a kind module, a server module and one line in each
  registry. The consumers that execute, discover, refresh and describe a
  source do not change for it.
- The query execution result (`QueryResult`, `QueryExecutionError`) moves to
  `src/lib/sources/execution.ts`, because it is what every kind returns.
- The model's source draft stays TimescaleDB-only and is not shown `kind`;
  a draft of another kind is its own decision.
- A source's kind cannot change on edit. Every panel names the source by id,
  and a panel's language follows its source.
