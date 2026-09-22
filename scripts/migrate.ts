import { Client } from "pg";
import type { Migration } from "./lib/migrations";
import {
  appliedMigrations,
  applyMigration,
  dryRun,
  ensureMigrationsTable,
  loadMigrations,
  orphanedMigrations,
  parseArgs,
  pendingMigrations,
  rollbackMigration,
  withAdvisoryLock,
} from "./lib/migrations";

/**
 * `npm run migrate` and its safety flags.
 *
 *   (no flags)        apply every pending migration, in filename order
 *   --check           exit 1 if anything is pending; apply nothing
 *   --dry-run         run the pending set in a transaction and roll it back
 *   --down <name>     undo exactly one applied migration
 *   --lock-timeout N  seconds to wait for the advisory lock (default 60)
 *
 * `--check` is the deploy gate: run it after the image is built and before it
 * is rolled out, and a deploy whose code needs a migration that has not run
 * fails the pipeline instead of the request path. Every mutating mode holds a
 * session advisory lock, so two migrate Jobs from the same rollout serialize.
 */

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Throws when a migration declares neither a rollback nor an irreversible
  // reason, so that gate applies to every mode including --check.
  const all = loadMigrations();

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await appliedMigrations(client);

    for (const name of orphanedMigrations(all, applied)) {
      console.warn(
        `warn   ${name} is recorded as applied but is not in migrations/. ` +
          `The database is ahead of this checkout.`,
      );
    }

    if (options.mode === "down") {
      return await withAdvisoryLock(client, options.lockTimeoutMs, () =>
        down(client, all, options.target ?? ""),
      );
    }

    const pending = pendingMigrations(all, applied);

    if (options.mode === "check") {
      if (pending.length === 0) {
        console.log(`up to date (${applied.length} applied)`);
        return 0;
      }
      console.error(
        `${pending.length} migration(s) pending:\n` +
          pending.map((m) => `  ${m.name}`).join("\n") +
          `\nRun 'npm run migrate' before deploying code that needs them.`,
      );
      return 1;
    }

    if (options.mode === "dry-run") {
      if (pending.length === 0) {
        console.log(`up to date (${applied.length} applied); nothing to dry run`);
        return 0;
      }
      for (const m of pending) console.log(`would apply  ${m.name}`);
      // Held under the lock: the trial run writes and rolls back, and a
      // concurrent real run would otherwise see it half-applied.
      await withAdvisoryLock(client, options.lockTimeoutMs, () =>
        dryRun(client, pending),
      );
      console.log(`dry run complete; ${pending.length} migration(s) rolled back`);
      return 0;
    }

    return await withAdvisoryLock(client, options.lockTimeoutMs, () =>
      apply(client, all),
    );
  } finally {
    await client.end();
  }
}

/**
 * Apply the pending set. The applied list is re-read inside the lock: another
 * runner may have finished between our first read and acquiring it.
 */
async function apply(client: Client, all: Migration[]) {
  const applied = await appliedMigrations(client);
  const done = new Set(applied);
  for (const m of all) {
    if (done.has(m.name)) {
      console.log(`skip   ${m.name}`);
      continue;
    }
    console.log(`apply  ${m.name}`);
    await applyMigration(client, m);
  }
  console.log("migrations complete");
  return 0;
}

/** Undo exactly one migration, refusing anything but the most recent. */
async function down(client: Client, all: Migration[], target: string) {
  const migration = all.find((m) => m.name === target);
  if (!migration) {
    console.error(`No migration named '${target}' in migrations/.`);
    return 1;
  }
  // Re-read inside the lock, for the same reason apply() does.
  const current = await appliedMigrations(client);
  const last = current.at(-1);
  if (!current.includes(target)) {
    console.error(`'${target}' is not applied; nothing to roll back.`);
    return 1;
  }
  if (last !== target) {
    console.error(
      `'${target}' is not the most recently applied migration ('${last}' is). ` +
        `Roll back one step at a time, newest first.`,
    );
    return 1;
  }
  if (migration.down === null) {
    console.error(
      `'${target}' is marked irreversible: ${migration.irreversible}\n` +
        `Undoing it needs a new forward migration, not a rollback.`,
    );
    return 1;
  }
  console.log(`down   ${target}`);
  await rollbackMigration(client, migration);
  console.log("rollback complete");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
