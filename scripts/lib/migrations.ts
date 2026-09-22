import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Client } from "pg";

/**
 * Shared migration machinery for scripts/migrate.ts and
 * scripts/migrate-verify.ts.
 *
 * Nothing here is imported by the app: migrations run from the CLI and from
 * the Docker `migrate` target, never from a request path. The module exists so
 * the parsing and planning rules can be unit tested without a database, and so
 * the two CLIs cannot drift in how they read a migration file.
 */

/** Directory holding the `NNN_name.sql` files, resolved from this module. */
export const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
);

/**
 * Arbitrary fixed key for pg_advisory_lock, unique to Holotable's migration
 * runner. Two concurrent runs against the same database contend on this key;
 * nothing else in the system takes an advisory lock.
 */
export const MIGRATION_LOCK_KEY = 4_027_083_161;

/** Marker line that opens the rollback section of a migration file. */
const ROLLBACK_MARKER = /^--[ \t]*rollback:[ \t]*$/m;

/** Marker line declaring a migration has no down path, with the reason. */
const IRREVERSIBLE_MARKER = /^--[ \t]*irreversible:[ \t]*(\S.*?)[ \t]*$/m;

export type Migration = {
  /** File name, which is also the primary key in schema_migrations. */
  name: string;
  /** Statements applied going forward. */
  up: string;
  /** Statements that undo `up`, or null when the migration is irreversible. */
  down: string | null;
  /** Why there is no down path, or null when the migration is reversible. */
  irreversible: string | null;
};

/**
 * Split one migration file into its up and down halves.
 *
 * Every migration must declare its down path exactly once: either a
 * `-- rollback:` section, whose remainder is executed verbatim by `--down`, or
 * an `-- irreversible: <reason>` line stating why there is none. Declaring
 * neither is an error rather than an implicit "no rollback", so an author has
 * to record the intent instead of leaving it to be inferred later.
 */
export function parseMigration(name: string, text: string): Migration {
  const irreversible = text.match(IRREVERSIBLE_MARKER);
  const rollback = text.match(ROLLBACK_MARKER);

  if (irreversible && rollback) {
    throw new Error(
      `${name}: declares both '-- irreversible:' and '-- rollback:'; pick one`,
    );
  }
  if (!irreversible && !rollback) {
    throw new Error(
      `${name}: missing a down path. Add a '-- rollback:' section with the ` +
        `statements that undo it, or '-- irreversible: <reason>' saying why ` +
        `it cannot be undone.`,
    );
  }

  if (irreversible) {
    return { name, up: text, down: null, irreversible: irreversible[1] };
  }

  const at = rollback?.index ?? 0;
  const up = text.slice(0, at);
  const down = text.slice(at + (rollback?.[0].length ?? 0));
  if (!hasStatement(down)) {
    throw new Error(
      `${name}: the '-- rollback:' section is empty. Add the statements that ` +
        `undo it, or use '-- irreversible: <reason>' instead.`,
    );
  }
  return { name, up, down, irreversible: null };
}

/** True when `sql` holds anything besides comments and whitespace. */
function hasStatement(sql: string): boolean {
  return sql.replace(/^[ \t]*--.*$/gm, "").trim().length > 0;
}

/** Read and parse every migration in `dir`, in filename order. */
export function loadMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => parseMigration(f, readFileSync(join(dir, f), "utf8")));
}

/** The migrations in `all` that `applied` does not already contain. */
export function pendingMigrations(all: Migration[], applied: string[]): Migration[] {
  const done = new Set(applied);
  return all.filter((m) => !done.has(m.name));
}

/**
 * Applied migrations recorded in the database but absent from migrations/.
 *
 * This is the "deployed code is older than the database" direction, and it is
 * reported rather than fixed: rolling the database forward past the code is a
 * decision for an operator, not for the migration runner.
 */
export function orphanedMigrations(all: Migration[], applied: string[]): string[] {
  const known = new Set(all.map((m) => m.name));
  return applied.filter((name) => !known.has(name));
}

/** Create schema_migrations if this is a fresh database. */
export async function ensureMigrationsTable(client: Client): Promise<void> {
  await client.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
}

/** Names recorded in schema_migrations, in filename order. */
export async function appliedMigrations(client: Client): Promise<string[]> {
  const res = await client.query<{ name: string }>(
    "SELECT name FROM schema_migrations ORDER BY name",
  );
  return res.rows.map((r) => r.name);
}

/**
 * Run `fn` holding the session-level advisory lock, so two migrate Jobs
 * started by the same rollout serialize instead of racing.
 *
 * The lock is polled rather than waited on: `pg_advisory_lock` blocks forever,
 * which in a Kubernetes Job means a pod that hangs instead of failing. Giving
 * up after `timeoutMs` turns a stuck peer into a failed pipeline step with an
 * error that says what happened.
 */
export async function withAdvisoryLock<T>(
  client: Client,
  timeoutMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS locked",
      [MIGRATION_LOCK_KEY],
    );
    if (res.rows[0]?.locked) break;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for the migration advisory ` +
          `lock (key ${MIGRATION_LOCK_KEY}). Another migrate run holds it; ` +
          `wait for it to finish or raise --lock-timeout.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    return await fn();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [MIGRATION_LOCK_KEY]);
  }
}

/**
 * Apply one migration and record it, in a single transaction. A migration that
 * fails partway leaves neither its statements nor its schema_migrations row.
 */
export async function applyMigration(client: Client, m: Migration): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(m.up);
    await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [m.name]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/** Undo one migration and forget it, in a single transaction. */
export async function rollbackMigration(client: Client, m: Migration): Promise<void> {
  if (m.down === null) {
    throw new Error(
      `${m.name} is marked irreversible (${m.irreversible}) and has no down path.`,
    );
  }
  await client.query("BEGIN");
  try {
    await client.query(m.down);
    await client.query("DELETE FROM schema_migrations WHERE name = $1", [m.name]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Run every pending migration inside one transaction and roll it back.
 *
 * This is what `--dry-run` can honestly promise. It is stronger than a parse
 * check — the statements execute against the real database, in order, so a
 * migration that depends on an earlier one is exercised properly and a
 * constraint that would fail against existing rows fails here too. It is still
 * not a guarantee: anything that cannot run inside a transaction (there is
 * none in migrations/ today) would behave differently, and timing against a
 * large table is not measured. Nothing is left behind either way.
 */
export async function dryRun(client: Client, pending: Migration[]): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const m of pending) {
      await client.query(m.up);
    }
  } finally {
    await client.query("ROLLBACK");
  }
}

type SchemaRow = Record<string, unknown>;

/**
 * A stable fingerprint of the public schema, used to prove that rolling a
 * migration back lands on exactly the shape that preceded it.
 *
 * schema_migrations is excluded on purpose: it is bookkeeping created before
 * the first migration and its contents change with every step, so including it
 * would make every comparison differ for reasons that are not schema drift.
 */
export async function schemaDigest(client: Client): Promise<string> {
  const columns = await client.query<SchemaRow>(
    `SELECT table_name, column_name, ordinal_position, data_type,
            is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name <> 'schema_migrations'
      ORDER BY table_name, column_name`,
  );
  const constraints = await client.query<SchemaRow>(
    `SELECT c.conname, c.contype, rel.relname AS table_name,
            pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE n.nspname = 'public' AND rel.relname <> 'schema_migrations'
      ORDER BY rel.relname, c.conname`,
  );
  const indexes = await client.query<SchemaRow>(
    `SELECT tablename, indexname, indexdef
       FROM pg_indexes
      WHERE schemaname = 'public' AND tablename <> 'schema_migrations'
      ORDER BY tablename, indexname`,
  );
  return digestRows([columns.rows, constraints.rows, indexes.rows]);
}

/**
 * Hash the ordered catalog rows behind {@link schemaDigest}. Split out so the
 * hashing is testable without a database.
 */
export function digestRows(groups: SchemaRow[][]): string {
  return createHash("sha256").update(JSON.stringify(groups)).digest("hex").slice(0, 16);
}

export type Mode = "apply" | "check" | "dry-run" | "down";

export type Options = {
  mode: Mode;
  /** The migration to undo; set only when mode is "down". */
  target: string | null;
  lockTimeoutMs: number;
};

const USAGE = `Usage: npm run migrate -- [--check | --dry-run | --down <name>] [--lock-timeout <seconds>]`;

export function parseArgs(argv: string[]): Options {
  const options: Options = { mode: "apply", target: null, lockTimeoutMs: 60_000 };
  let modeFlag: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const setMode = (mode: Mode) => {
      if (modeFlag && modeFlag !== arg) {
        throw new Error(`${arg} cannot be combined with ${modeFlag}. ${USAGE}`);
      }
      modeFlag = arg;
      options.mode = mode;
    };

    switch (arg) {
      case "--check":
        setMode("check");
        break;
      case "--dry-run":
        setMode("dry-run");
        break;
      case "--down": {
        setMode("down");
        const name = argv[++i];
        if (!name || name.startsWith("--")) {
          throw new Error(`--down needs the name of one migration. ${USAGE}`);
        }
        options.target = name;
        break;
      }
      case "--lock-timeout": {
        const seconds = Number(argv[++i]);
        if (!Number.isFinite(seconds) || seconds < 0) {
          throw new Error(`--lock-timeout needs a non-negative number of seconds.`);
        }
        options.lockTimeoutMs = seconds * 1000;
        break;
      }
      default:
        throw new Error(`Unknown argument '${arg}'. ${USAGE}`);
    }
  }
  return options;
}
