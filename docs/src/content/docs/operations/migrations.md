---
title: Database migrations
description: Applying migrations safely from a pipeline — the pending check, the advisory lock, dry runs, the rollback convention, and expand/contract for breaking changes.
sidebar:
  order: 10
---

Migrations are plain SQL files in `migrations/`, applied in filename order by
`scripts/migrate.ts` and recorded one row per file in `schema_migrations`. Each
file is applied inside a transaction, so a migration that fails partway leaves
neither its statements nor its bookkeeping row.

## The commands

```bash
npm run migrate                     # apply every pending migration
npm run migrate -- --check          # exit 1 if anything is pending; apply nothing
npm run migrate -- --dry-run        # run the pending set and roll it back
npm run migrate -- --down <name>    # undo exactly one migration
npm run migrate:verify              # round-trip the whole set (scratch database)
```

All of them read `DATABASE_URL`. `--lock-timeout <seconds>` (default 60) caps
how long a run waits for the advisory lock described below.

### `--check` is the deploy gate

This is the one that matters. Run it after the image is built and before it is
rolled out:

```bash
npm run migrate -- --check || exit 1
```

Without it, deploying code that expects a migration which has not run turns
into a runtime failure in the request path. With it, the pipeline stops. It
applies nothing, so it is safe to run from anywhere that can reach the
database.

It also warns — without failing — when `schema_migrations` records a migration
that is not in the checkout. That is the opposite direction: the database is
ahead of the code, usually a rollback of the application without a rollback of
the schema. Rolling the database forward past the code is an operator's call,
not the runner's, so it is reported rather than acted on.

### The advisory lock

Every mutating mode holds a session-level `pg_advisory_lock` for the whole run,
so two migrate Jobs started by the same rollout serialize instead of racing.
The lock is polled rather than waited on: `pg_advisory_lock` blocks forever,
which in a Kubernetes Job means a pod that hangs instead of failing. After
`--lock-timeout` seconds a run gives up with an error naming the lock.

### `--dry-run`

Runs the pending migrations in order, in one transaction, and rolls the whole
thing back. That is stronger than a parse check — the statements execute
against the real server, so a migration that depends on an earlier one is
exercised properly and a constraint that would fail against existing rows fails
here. It is not a guarantee: anything that cannot run inside a transaction
would behave differently, and it says nothing about how long the migration
takes against a large table.

## The rollback convention

Every migration declares its down path, in the same file, exactly once. The
runner refuses to load a migration that declares neither — including for
`--check` — so the intent is recorded rather than inferred later.

A reversible migration ends with a `-- rollback:` line on its own, and
everything after it is the down path:

```sql
CREATE TABLE IF NOT EXISTS widgets (
  id TEXT PRIMARY KEY
);

-- rollback:
DROP TABLE IF EXISTS widgets;
```

An irreversible one says so, with the reason:

```sql
-- irreversible: the dropped column's values are not recoverable
ALTER TABLE widgets DROP COLUMN legacy_id;
```

`npm run migrate -- --down <name>` undoes exactly one step, and only the most
recently applied one. Rolling back several means running it several times,
newest first. Undoing an irreversible migration needs a new forward migration,
not a rollback.

### What CI proves

The `Migrations` job runs against a TimescaleDB service container and covers
each claim above:

- `--check` fails on an unmigrated database and passes once migrations are
  applied.
- `--dry-run` leaves nothing applied.
- `npm run migrate:verify` walks the set from empty to fully applied, then back
  down. After each rollback the schema must match a fingerprint of exactly what
  the previous migration left — columns, constraints and indexes from the
  catalog — and re-applying must return it to where it was. A down path that
  forgets to drop one table fails here. Column *order* is compared as a rank
  rather than as `ordinal_position`, because PostgreSQL never reuses an
  `attnum`: dropping a column and adding it back leaves a permanent gap, and an
  `ADD COLUMN` migration with a correct rollback would otherwise fail on a
  difference no query can see.
- Re-running the full set against an already-migrated database is a no-op, both
  as a runner decision and at the SQL level, which is why
  `CREATE ... IF NOT EXISTS` is the house style.

`migrate:verify` rolls migrations back, so it refuses to start unless the
public schema is empty. Never point it at a database you care about.

A parse-only dry run cannot catch a rollback that fails only against a live
server with the TimescaleDB extension loaded. Running the statements can, which
is why the down path is exercised for real rather than inspected.

## Breaking changes: expand and contract

A migration that changes an existing column or table in place assumes the old
code and the new code never run at the same time. During a rolling update they
always do. Split the change across releases instead, so every intermediate
state is one both versions can live with.

**Renaming `sources.name` to `sources.label`:**

1. **Expand.** Add `label`, nullable, and backfill it from `name`. Deploy code
   that writes both and reads `label` with a fallback to `name`. The old
   version is still correct: it neither writes nor reads the new column.
2. **Migrate the readers.** Once every replica is on that version, deploy code
   that reads only `label`. Still writing both.
3. **Contract.** Deploy code that no longer mentions `name`, then a migration
   dropping the column. This one is irreversible — the values are gone — and
   says so.

The same shape covers the other breaking changes:

| Change | Expand | Contract |
| --- | --- | --- |
| Drop a column | Stop writing it | Drop it once no deployed version reads it |
| Add a `NOT NULL` column | Add it nullable with a default, backfill | Add the constraint |
| Change a type | Add the new column, write both | Drop the old one |
| Split a table | Write both, read the old one | Move reads, then drop |

Each step is a separate migration and a separate release. That is what makes
every step individually reversible, and it is why the runner insists on a
declared down path: a migration whose only honest answer is "this cannot be
undone" is usually a contract step that was merged too early.
