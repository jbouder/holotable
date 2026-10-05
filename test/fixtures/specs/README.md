# IR fixtures

Dashboard specs exactly as a database stores them, one per file, and the
contract every build is held to by `test/ir-contract.test.ts` (#90): each one
loads through `StoredDashboard`, each panel's SQL passes the guard against
`catalogs.json`, and each panel's executable plan matches
`test/snapshots/executable-plans.json`.

## Rules

- **Never edit a fixture.** `index.json` records a digest of each file's
  content, and the contract test fails when they disagree. A spec saved last
  year is not rewritten when the IR changes, so neither is its fixture.
- **A breaking IR change adds, it does not rewrite.** Bump `SPEC_VERSION`,
  append the upgrader to `src/lib/ir/upgrade.ts`, and leave every existing
  fixture alone: it must still load through the new upgrader. Then add
  fixtures of the new version beside the old ones; the test asks for at least
  one at the current version.
- **Files are named `v<specVersion>-<slug>.json`**, for the version the spec
  was saved at (1 for one with no `specVersion`, like `v1-unversioned.json`).
- **Catalogs are added, never changed.** `catalogs.json` holds, per source
  id, the schema, tables and row filter a fixture's SQL is validated against.
  Never a host, a port, a database name or a `secret_ref`.

## Adding one

Capture a dashboard from a live database:

```bash
npm run fixture:capture -- <dashboard-id> --name <slug> [--version <n>]
```

It reads the stored jsonb without upgrading it, refuses a spec the current
build cannot load, adds the catalog of every source it reads, and records the
file in `index.json`. `--source <id>=<new-id>` re-points a source whose
catalog differs from the one already recorded under that id.

A hand-written fixture for a case no real dashboard has goes through the same
`addFixture` in `scripts/lib/spec-fixtures.ts`, with an `origin` that says
what it covers. The coverage test lists the cases the library must hold:
every panel kind, every limit the schema declares, variables, annotations,
and a panel's own window and refresh.

## Snapshots

`test/snapshots/ir.schema.json` is the JSON Schema derived from the IR, and
diffs on any schema change at all. Rewrite both snapshots with
`UPDATE_SNAPSHOTS=1 npm test` and review the diff with the change.
