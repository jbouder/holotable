import "./lib/env";
import { Client } from "pg";
import type { Migration } from "./lib/migrations";
import {
  applyMigration,
  appliedMigrations,
  ensureMigrationsTable,
  loadMigrations,
  rollbackMigration,
  schemaDigest,
} from "./lib/migrations";

/**
 * `npm run migrate:verify` — exercise the migration set against a real
 * PostgreSQL, from empty to fully applied and back.
 *
 * A parse-only dry run cannot catch a rollback that fails against a live
 * server with the TimescaleDB extension loaded; running the statements can.
 * This is the CI job's whole body, and it needs a database it may destroy:
 * it refuses to start unless the public schema is empty.
 *
 * Three properties, in one pass:
 *
 *   1. Every migration applies from the state its predecessor leaves.
 *   2. Every reversible migration's down path returns the schema to exactly
 *      the fingerprint its predecessor left, and re-applying returns it to the
 *      fingerprint it had before. Irreversible migrations are reported and
 *      the walk stops there, since nothing below them can be reached.
 *   3. Re-running the whole set against a migrated database is a no-op.
 */

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  const migrations = loadMigrations();
  if (migrations.length === 0) throw new Error("No migrations found");

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await assertEmptySchema(client);
    await ensureMigrationsTable(client);

    // digests[i] is the schema after migrations[0..i-1]; digests[0] is empty.
    const digests: string[] = [await schemaDigest(client)];
    for (const m of migrations) {
      console.log(`apply  ${m.name}`);
      await applyMigration(client, m);
      digests.push(await schemaDigest(client));
    }

    await assertIdempotent(client, migrations);

    // Walk back down, newest first, checking each step lands where it started.
    for (let i = migrations.length - 1; i >= 0; i--) {
      const m = migrations[i];
      if (m.down === null) {
        console.log(`skip   ${m.name} (irreversible: ${m.irreversible})`);
        console.log(
          `       stopping the walk here; ${i} earlier migration(s) cannot be ` +
            `reached without dropping the database.`,
        );
        break;
      }

      console.log(`down   ${m.name}`);
      await rollbackMigration(client, m);
      assertDigest(m.name, "rollback", digests[i], await schemaDigest(client));

      console.log(`re-up  ${m.name}`);
      await applyMigration(client, m);
      assertDigest(m.name, "re-apply", digests[i + 1], await schemaDigest(client));

      // Leave it rolled back so the next iteration starts from the state its
      // own predecessor produced.
      await rollbackMigration(client, m);
    }

    console.log(`\nverified ${migrations.length} migration(s)`);
    return 0;
  } finally {
    await client.end();
  }
}

/**
 * Refuse to run against anything but a scratch database. The script drops
 * every table the migrations create, so pointing it at a real one would be
 * destructive; schema_migrations alone is tolerated so a repeat run works.
 */
async function assertEmptySchema(client: Client): Promise<void> {
  const res = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename`,
  );
  if (res.rowCount) {
    throw new Error(
      `Refusing to run: the public schema already holds ` +
        `${res.rows.map((r) => r.tablename).join(", ")}. ` +
        `migrate-verify rolls migrations back and needs a scratch database.`,
    );
  }
  const applied = await client
    .query<{ name: string }>("SELECT name FROM schema_migrations")
    .catch(() => ({ rowCount: 0, rows: [] as { name: string }[] }));
  if (applied.rowCount) {
    throw new Error(
      `Refusing to run: schema_migrations already records ` +
        `${applied.rows.map((r) => r.name).join(", ")} but the tables are gone. ` +
        `Drop and recreate the database.`,
    );
  }
}

/**
 * Re-running the applied set must change nothing. `applyMigration` is never
 * called here — a second pass legitimately skips everything — so the check is
 * that the runner considers each one applied and the schema is untouched.
 */
async function assertIdempotent(client: Client, migrations: Migration[]): Promise<void> {
  const before = await schemaDigest(client);
  const applied = new Set(await appliedMigrations(client));
  for (const m of migrations) {
    if (!applied.has(m.name)) {
      throw new Error(`${m.name} applied but is not recorded in schema_migrations`);
    }
  }

  // The house style is CREATE ... IF NOT EXISTS, which means the statements
  // themselves should also be safe to re-run even though the runner would skip
  // them. Prove it, then roll it back.
  await client.query("BEGIN");
  try {
    for (const m of migrations) {
      await client.query(m.up);
    }
  } catch (err) {
    await client.query("ROLLBACK");
    throw new Error(
      `Re-running the migration set against a migrated database is not a ` +
        `no-op: ${err instanceof Error ? err.message : err}`,
    );
  }
  await client.query("ROLLBACK");

  assertDigest("the full set", "re-run", before, await schemaDigest(client));
  console.log(`ok     re-running the full set is a no-op`);
}

function assertDigest(name: string, step: string, want: string, got: string): void {
  if (want !== got) {
    throw new Error(
      `${name}: schema after ${step} is ${got}, expected ${want}. ` +
        `The down path does not undo the up path exactly.`,
    );
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
