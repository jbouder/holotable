---
title: "ADR 1: Generating one dashboard over several sources"
description: Why a multi-source dashboard is one model call over fenced per-source catalogs, and what that does to invariant 9.
---

- **Status:** accepted, 2026-10-06
- **Issue:** [#104](https://github.com/jbouder/holotable/issues/104)
- **Changes:** [invariant 9](/architecture/invariants/#9-the-catalog-prompt-is-metadata-only-and-that-metadata-is-untrusted)

## Context

A dashboard could already span sources: `resolveAndValidateDashboard` checks
each panel's SQL against its own source and only requires every source to be
in one workspace. It could not be *generated* that way. `/api/generate` took
one `sourceId`, the system prompt carried that source's catalog, and the SQL
rules told the model that every panel must use it. Putting application and
infrastructure metrics on one dashboard meant generating against one source
and hand-editing every panel that belonged to the other.

Two invariants bound the design. Invariant 1 says the model runs **exactly
once** per author action, with one bounded repair. Invariant 9 sent the
catalog of a **single** selected, authorized source per call.

## Options

1. **N fenced catalogs in one call.** The author picks up to N authorized
   sources; each catalog goes into its own fenced block (the #19 treatment)
   under a heading naming its `sourceId`, and every panel must name one of
   them and read only that one's tables.
2. **Generate per source and merge.** One call per source, each seeing one
   catalog, then the panels are merged and laid out again. Keeps invariant 9
   as written, but breaks invariant 1, costs N times the budget and rate
   allowance, and needs a way to split the author's request across sources
   before any model has seen it.
3. **Two-phase routing.** A cheap call routes the request and drafts a
   sub-prompt per source, then per-source generation follows. Probably the
   best quality, the most moving parts, and it changes invariants 1 and 9.

## Decision

**Option 1, with at most three sources per generation** (the primary and two
more), all in one workspace.

- Invariant 1 stands: a multi-source dashboard is still one author action and
  one model call, budgeted, rate limited, logged and repairable like any other.
- The request keeps `sourceId` as the primary and adds
  `additionalSourceIds` (at most two) for the `dashboard` and
  `dashboard-refine` modes. A panel edit and an explore question keep one
  source. A single-source request produces exactly the prompt it did before,
  so the eval recordings stay current.
- Each source is resolved and checked on its own record
  (`resolveGenerationSources` in `src/lib/generation-sources.ts`): live,
  `dashboard:generate` for the caller in its workspace, a catalog that can
  produce working SQL, and the primary's workspace. A source that fails any
  check refuses the whole request; none is dropped quietly.
- The prompt names every `sourceId` and gives each catalog its own fenced
  block, so every table is attributable to one source. The SQL rules forbid
  using one source's table under another's id and combining sources in a
  query.
- Prompt size is bounded by the cap: each catalog is already bounded by the
  registry schema, and `baseSystem` refuses more than three sources.
- Cross-source table confusion is enforced where it always was: on save,
  each panel's SQL is validated against the catalog of the source it names,
  so a panel that reads source A's table under source B's id is refused. The
  prompt rule is a courtesy; the guard is the enforcement.

## Consequences

- Invariant 9 now reads "the catalogs of the selected, authorized sources,
  at most three, each fenced on its own".
- The prompt grows with each source picked. Three large catalogs make a long
  prompt; the cap is what keeps that bounded, and the author chooses whether
  to pay for it.
- The model can still mix sources up. When it does, the panel fails
  validation at save rather than running against the wrong database.
- Cross-source joins in one query remain out of scope: a query runs against
  one source's connection, and nothing here changes that.
- If quality across sources turns out to need routing (option 3), that is a
  new ADR, because it would change invariant 1.
