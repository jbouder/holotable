import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { loadMigrations, schemaDigest } from "../../scripts/lib/migrations";
import { dbUrl, needsDb, ownerClient, unique } from "./support";

/*
 * The config-store migrations from an empty database (#87), through the real
 * `npm run migrate` CLI rather than its library: a fresh database every run,
 * so "from empty" is never "from whatever the last run left".
 * `npm run migrate:verify` in CI proves each down path; this proves the
 * forward path a first deploy takes, and that running it again is a no-op.
 */

function migrate(database: string, ...args: string[]) {
  const url = new URL(dbUrl as string);
  url.pathname = `/${database}`;
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts", ...args], {
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: url.toString() },
  });
}

test(
  "migrations apply from empty, and a second run changes nothing",
  needsDb,
  async () => {
    const database = unique("holo_it_migrate").replaceAll("-", "_");
    const admin = await ownerClient();
    await admin.query(`CREATE DATABASE ${database}`);
    try {
      const pending = migrate(database, "--check");
      assert.notEqual(pending.status, 0, "an empty database has every migration pending");

      const first = migrate(database);
      assert.equal(first.status, 0, first.stderr);

      const client = await ownerClient(database);
      try {
        const { rows } = await client.query<{ name: string }>(
          "SELECT name FROM schema_migrations ORDER BY name",
        );
        assert.deepEqual(
          rows.map((r) => r.name),
          loadMigrations().map((m) => m.name),
        );
        const before = await schemaDigest(client);

        const second = migrate(database);
        assert.equal(second.status, 0, second.stderr);
        assert.doesNotMatch(second.stdout, /apply\s+\d{3}_/, "nothing is applied twice");
        assert.equal(await schemaDigest(client), before);

        const check = migrate(database, "--check");
        assert.equal(check.status, 0, check.stderr);
      } finally {
        await client.end();
      }
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
      await admin.end();
    }
  },
);
