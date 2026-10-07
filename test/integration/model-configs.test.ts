import assert from "node:assert/strict";
import { after, test } from "node:test";
import { openModelKey, sealModelKey } from "@/lib/ai/model-resolution";
import { pgModelConfigStore as store } from "@/lib/db/model-configs";
import { closePool, query } from "@/lib/db/pg";
import { needsDb, unique } from "./support";

/*
 * The model configuration rows (#331) against the real config store: a key
 * left out of a save is kept, an explicit null clears it, and going back to
 * the environment drops it with the settings.
 */

const WORKSPACE = unique("ws-model");
const SUB = unique("user-model");

after(async () => {
  if (!process.env.MIGRATE_TEST_DATABASE_URL) return;
  await query("DELETE FROM workspace_llm_config WHERE workspace_id = $1", [WORKSPACE]);
  await query("DELETE FROM user_llm_config WHERE user_sub = $1", [SUB]);
  await closePool();
});

const settings = { baseUrl: "https://api.example.com/v1", model: "m1", api: "chat" };

test(
  "a workspace configuration keeps, replaces and clears its key",
  needsDb,
  async () => {
    assert.equal(await store.workspace(WORKSPACE), null);

    const first = await store.saveWorkspace({
      workspaceId: WORKSPACE,
      config: {
        provider: "openai-compatible",
        settings,
        apiKey: sealModelKey("sk-first"),
      },
      allowPersonalKeys: false,
      updatedBy: "admin",
    });
    assert.deepEqual(first.config?.settings, settings);
    assert.deepEqual(openModelKey(first.config?.apiKey ?? null), {
      state: "ok",
      key: "sk-first",
    });

    const kept = await store.saveWorkspace({
      workspaceId: WORKSPACE,
      config: {
        provider: "openai-compatible",
        settings: { ...settings, model: "m2" },
        apiKey: "keep",
      },
      allowPersonalKeys: true,
      updatedBy: "admin",
    });
    assert.deepEqual(kept.config?.settings, { ...settings, model: "m2" });
    assert.equal(kept.allowPersonalKeys, true);
    assert.deepEqual(openModelKey(kept.config?.apiKey ?? null), {
      state: "ok",
      key: "sk-first",
    });

    const cleared = await store.saveWorkspace({
      workspaceId: WORKSPACE,
      config: { provider: "openai-compatible", settings, apiKey: null },
      allowPersonalKeys: true,
      updatedBy: "admin",
    });
    assert.equal(cleared.config?.apiKey, null);

    // Back to the environment: the row stays for the toggle, with no key.
    const env = await store.saveWorkspace({
      workspaceId: WORKSPACE,
      config: null,
      allowPersonalKeys: true,
      updatedBy: "admin",
    });
    assert.equal(env.config, null);
    assert.equal(env.allowPersonalKeys, true);
    const [raw] = await query<{ api_key: Buffer | null }>(
      "SELECT api_key FROM workspace_llm_config WHERE workspace_id = $1",
      [WORKSPACE],
    );
    assert.equal(raw.api_key, null);
  },
);

test(
  "a personal configuration is one row per subject, and deletes",
  needsDb,
  async () => {
    assert.equal(await store.user(SUB), null);
    await store.saveUser({
      sub: SUB,
      config: {
        provider: "openai-compatible",
        settings,
        apiKey: sealModelKey("sk-mine"),
      },
    });
    const kept = await store.saveUser({
      sub: SUB,
      config: { provider: "openai-compatible", settings, apiKey: "keep" },
    });
    assert.deepEqual(openModelKey(kept.apiKey), { state: "ok", key: "sk-mine" });
    assert.equal(kept.updatedBy, SUB);
    assert.equal(await store.deleteUser(SUB), true);
    assert.equal(await store.deleteUser(SUB), false);
    assert.equal(await store.user(SUB), null);
  },
);
