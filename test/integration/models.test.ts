import assert from "node:assert/strict";
import { after, test } from "node:test";
import { loadMigrations } from "../../scripts/lib/migrations";
import { openCredentials, sealCredentials } from "@/lib/ai/model-resolution";
import { DuplicateModelName, pgModelStore as store } from "@/lib/db/models";
import { closePool, query } from "@/lib/db/pg";
import { needsDb, ownerClient, unique } from "./support";

/*
 * The model catalog (#439) against the real config store: models are
 * reached only through their owner, names are unique per owner ignoring
 * case, credentials are kept or replaced, deleting the default clears it,
 * and migration 022 moves a 017 slot into the catalog once.
 */

const WORKSPACE = unique("ws-models");
const OTHER = unique("ws-models-other");
const SUB = unique("user-models");
const LEGACY_WS = unique("ws-legacy");
const LEGACY_SUB = unique("user-legacy");

after(async () => {
  if (!process.env.MIGRATE_TEST_DATABASE_URL) return;
  const workspaces = [WORKSPACE, OTHER, LEGACY_WS];
  await query(
    "DELETE FROM llm_models WHERE workspace_id = ANY($1) OR user_sub = ANY($2)",
    [workspaces, [SUB, LEGACY_SUB]],
  );
  await query("DELETE FROM workspace_llm_config WHERE workspace_id = ANY($1)", [
    workspaces,
  ]);
  await closePool();
});

const settings = { model: "claude" };
const owner = { scope: "workspace" as const, workspaceId: WORKSPACE };

test(
  "a workspace's models are its own, uniquely named, and keep or replace credentials",
  needsDb,
  async () => {
    const created = await store.create(
      owner,
      {
        name: "Claude",
        provider: "anthropic",
        settings,
        credentials: sealCredentials({ apiKey: "sk-first" }),
      },
      "admin",
    );
    assert.equal(created.scope, "workspace");
    assert.equal(created.workspaceId, WORKSPACE);
    assert.deepEqual(openCredentials(created.credentials), {
      state: "ok",
      credentials: { apiKey: "sk-first" },
    });

    await assert.rejects(
      store.create(
        owner,
        { name: "claude", provider: "anthropic", settings, credentials: null },
        "admin",
      ),
      DuplicateModelName,
    );
    // Another workspace may use the same name, and cannot see this one.
    const elsewhere = { scope: "workspace" as const, workspaceId: OTHER };
    await store.create(
      elsewhere,
      { name: "Claude", provider: "anthropic", settings, credentials: null },
      "admin",
    );
    assert.equal(await store.get(elsewhere, created.id), null);
    assert.equal(
      await store.update(
        elsewhere,
        created.id,
        { name: "x", provider: "anthropic", settings, credentials: null },
        "eve",
      ),
      null,
    );
    assert.equal(await store.delete(elsewhere, created.id), false);
    assert.equal(await store.get(owner, "not-a-uuid"), null);

    const kept = await store.update(
      owner,
      created.id,
      {
        name: "Claude 2",
        provider: "anthropic",
        settings: { model: "claude-2" },
        credentials: "keep",
      },
      "admin2",
    );
    assert.equal(kept?.name, "Claude 2");
    assert.equal(kept?.updatedBy, "admin2");
    assert.deepEqual(openCredentials(kept?.credentials ?? null), {
      state: "ok",
      credentials: { apiKey: "sk-first" },
    });

    await store.saveWorkspace({
      workspaceId: WORKSPACE,
      defaultModel: created.id,
      allowPersonalKeys: true,
      updatedBy: "admin",
    });
    assert.equal((await store.workspace(WORKSPACE))?.defaultModel, created.id);
    assert.equal(await store.delete(owner, created.id), true);
    assert.equal((await store.workspace(WORKSPACE))?.defaultModel, null);
    assert.deepEqual(await store.list(owner), []);
  },
);

test("a person's models are theirs alone", needsDb, async () => {
  const mine = { scope: "personal" as const, sub: SUB };
  const created = await store.create(
    mine,
    { name: "Mine", provider: "openai", settings: { model: "gpt" }, credentials: null },
    SUB,
  );
  assert.equal(created.userSub, SUB);
  assert.equal(created.workspaceId, null);
  assert.equal(
    await store.get({ scope: "personal", sub: "someone-else" }, created.id),
    null,
  );
  assert.equal(
    await store.get({ scope: "workspace", workspaceId: SUB }, created.id),
    null,
  );
  assert.equal((await store.list(mine)).length, 1);
});

test(
  "migration 022 moves a 017 slot into the catalog once, and 024 drops the slots",
  needsDb,
  async () => {
    const migrations = loadMigrations();
    const expand = migrations.find((m) => m.name.startsWith("022_"));
    const contract = migrations.find((m) => m.name.startsWith("024_"));
    assert.ok(expand && contract?.down);
    const client = await ownerClient();
    const run = async (sql: string) => {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("COMMIT");
    };
    try {
      // Back to the expand state: 024's rollback brings the 017 slots back.
      await run(contract.down);
      const legacyKey = sealCredentials({ apiKey: "sk-legacy" });
      await client.query(
        `INSERT INTO workspace_llm_config
         (workspace_id, provider, settings, api_key, allow_personal_keys, updated_by)
       VALUES ($1, 'openai-compatible', $2::jsonb, $3, true, 'admin')`,
        [
          LEGACY_WS,
          JSON.stringify({
            baseUrl: "https://api.example.com/v1",
            model: "m",
            api: "chat",
          }),
          legacyKey,
        ],
      );
      await client.query(
        `INSERT INTO user_llm_config (user_sub, provider, settings, api_key)
       VALUES ($1, 'openai-compatible', $2::jsonb, NULL)`,
        [
          LEGACY_SUB,
          JSON.stringify({
            baseUrl: "https://api.example.com/v1",
            model: "mine",
            api: "chat",
          }),
        ],
      );
      // Twice: the move is guarded, so a second run copies nothing.
      await run(expand.up);
      await run(expand.up);

      const moved = await store.list({ scope: "workspace", workspaceId: LEGACY_WS });
      assert.equal(moved.length, 1);
      assert.equal(moved[0].name, "Workspace model");
      assert.deepEqual(openCredentials(moved[0].credentials), {
        state: "ok",
        credentials: { apiKey: "sk-legacy" },
      });
      const ws = await store.workspace(LEGACY_WS);
      assert.equal(ws?.defaultModel, moved[0].id);
      assert.equal(ws?.allowPersonalKeys, true);
      const personal = await store.list({ scope: "personal", sub: LEGACY_SUB });
      assert.deepEqual(
        personal.map((m) => [
          m.name,
          (m.settings as { model: string }).model,
          m.credentials,
        ]),
        [["Personal model", "mine", null]],
      );
    } finally {
      // Forward again: the slots go, the catalog and the default stay.
      await run(contract.up);
      await client.end();
    }
    const columns = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
      WHERE table_name = 'workspace_llm_config' ORDER BY column_name`,
    );
    assert.deepEqual(
      columns.map((c) => c.column_name),
      [
        "allow_personal_keys",
        "default_model",
        "updated_at",
        "updated_by",
        "workspace_id",
      ],
    );
    assert.equal(
      (
        await query<{ t: string | null }>(
          "SELECT to_regclass('user_llm_config')::text AS t",
        )
      )[0].t,
      null,
    );
    assert.equal((await store.workspace(LEGACY_WS))?.allowPersonalKeys, true);
  },
);
