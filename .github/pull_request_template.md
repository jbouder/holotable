## What changed

<!-- The change itself, in a sentence or two. -->

## Why

<!--
Why this, and why now. Link the issue it closes ("Closes #123"). If the diff
takes a non-obvious route, say why the obvious one did not work.
-->

## Checks

<!-- CI runs these too. Tick what you ran locally; note anything you skipped. -->

- [ ] `npm run lint`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Verified in the running app (say how — Docker Compose, `npm run dev`)

## Invariants

Holotable executes model-authored SQL against a live database. These are the
guarantees that make that safe, each with an enforcement point in
[Invariants](https://github.com/jbouder/holotable/blob/main/docs/src/content/docs/architecture/invariants.md).

Confirm the change preserves them — or, if it deliberately moves one of these
lines, say so under **Notes** and link the issue where that was agreed.

- [ ] **IR contract preserved** — `src/lib/ir.ts` is still the single shared
      schema; no parallel TypeScript-only shape was introduced, and every
      producer and consumer was updated together.
- [ ] **The model still generates specs, never data** — nothing renders metric
      values that did not come from server-side query execution.
- [ ] **SQL guard not weakened** — SELECT-only, allowlist, denylist, row/time
      limits, and read-only execution are intact; any widening is deliberate
      and covered by a test.
- [ ] **The server still owns time** — concrete ranges are resolved and
      injected server-side, bound to the panel's `timeField`; neither client
      nor model supplies an authoritative window.
- [ ] **No secrets in specs** — panels carry only a stable `sourceId`; no
      credentials or connection details reach a dashboard spec, a panel config,
      or any client-visible payload.
- [ ] **Authorization unchanged or tightened** — access is not broadened
      implicitly, and it is still derived from the validated identity rather
      than from a request field.

## Notes

<!--
Anything a reviewer should know: a deliberate trade-off, a follow-up you are
filing, a screenshot for a UI change, a migration that needs running.
-->
