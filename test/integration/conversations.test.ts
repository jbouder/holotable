import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { UIMessage } from "ai";
import { persistableMessage } from "@/lib/chat/persist";
import { pgConversationStore as store } from "@/lib/db/conversations";
import { closePool, query } from "@/lib/db/pg";
import { needsDb, unique } from "./support";

/*
 * The Chat conversation store (#416) against the real config store: who can
 * read a conversation, what a stored message holds, and the bounds.
 */

const ALICE = unique("alice");
const BOB = unique("bob");
const WS = unique("ws-chat");
const RANGE = { from: "now-1h", to: "now" };
const RETENTION = { limit: 100, retentionDays: 30 };

after(async () => {
  if (!process.env.MIGRATE_TEST_DATABASE_URL) return;
  await query("DELETE FROM conversations WHERE user_sub = ANY($1)", [[ALICE, BOB]]);
  await closePool();
});

function create(userSub: string, max = 200) {
  return store.create({
    id: randomUUID(),
    userSub,
    workspaceId: WS,
    sourceIds: ["src-metrics"],
    timeRange: RANGE,
    max,
    retentionDays: 30,
  });
}

const drawn = {
  id: "a1",
  role: "assistant",
  parts: [
    {
      type: "tool-showPanel",
      toolCallId: "c1",
      state: "output-available",
      input: {
        title: "Requests by service",
        viz: "table",
        query: { sourceId: "src-metrics", sql: "SELECT service FROM http_requests" },
      },
      output: {
        ok: true,
        panelId: "p1",
        spec: {},
        columns: ["service"],
        rows: Array.from({ length: 10_000 }, (_, i) => ({ service: `svc-${i}` })),
        rowCount: 10_000,
        window: { from: 0, to: 1 },
      },
    },
  ],
} as unknown as UIMessage;

test("a conversation is its owner's alone", needsDb, async () => {
  const mine = await create(ALICE);
  assert.equal((await store.get(mine.id, ALICE, 30))?.id, mine.id);
  assert.equal(await store.get(mine.id, BOB, 30), null);
  assert.equal(await store.update(mine.id, BOB, { title: "stolen" }), null);
  assert.equal(await store.remove(mine.id, BOB), false);
  // Bob's append to it writes nothing.
  await store.append({
    conversationId: mine.id,
    userSub: BOB,
    messages: [{ id: "u1", role: "user", content: { parts: [] } }],
    retention: RETENTION,
  });
  assert.deepEqual(await store.messages(mine.id, ALICE, RETENTION), []);
  assert.deepEqual(await store.messages(mine.id, BOB, RETENTION), []);
});

test(
  "a stored turn names the conversation and holds no result rows",
  needsDb,
  async () => {
    const c = await create(ALICE);
    await store.append({
      conversationId: c.id,
      userSub: ALICE,
      messages: [
        { id: "u1", role: "user", content: { parts: [{ type: "text", text: "hi" }] } },
        { id: "a1", role: "assistant", content: persistableMessage(drawn) },
      ],
      title: "Requests by service",
      retention: RETENTION,
    });
    const read = await store.messages(c.id, ALICE, RETENTION);
    assert.deepEqual(
      read.map((m) => m.id),
      ["u1", "a1"],
    );
    const [row] = await query<{ bytes: number; has_rows: boolean }>(
      `SELECT octet_length(content::text) AS bytes,
            content #> '{parts,0,output}' ? 'rows' AS has_rows
     FROM conversation_messages WHERE conversation_id = $1 AND id = 'a1'`,
      [c.id],
    );
    assert.equal(row.has_rows, false);
    assert.ok(row.bytes < 2_000, `stored ${row.bytes} bytes`);
    assert.equal((await store.get(c.id, ALICE, 30))?.title, "Requests by service");

    // A later turn does not rename it.
    await store.append({
      conversationId: c.id,
      userSub: ALICE,
      messages: [{ id: "u2", role: "user", content: { parts: [] } }],
      title: "Something else",
      retention: RETENTION,
    });
    assert.equal((await store.get(c.id, ALICE, 30))?.title, "Requests by service");
  },
);

test("messages are capped per conversation, newest kept", needsDb, async () => {
  const c = await create(ALICE);
  for (let i = 0; i < 5; i++) {
    await store.append({
      conversationId: c.id,
      userSub: ALICE,
      messages: [{ id: `m${i}`, role: "user", content: { parts: [] } }],
      retention: { limit: 3, retentionDays: 30 },
    });
  }
  const kept = await store.messages(c.id, ALICE, { limit: 100, retentionDays: 30 });
  assert.deepEqual(
    kept.map((m) => m.id),
    ["m2", "m3", "m4"],
  );
});

test("past the cap, the least recently used conversation goes", needsDb, async () => {
  const owner = unique("carol");
  try {
    const first = await create(owner, 2);
    const second = await create(owner, 2);
    // Using the first makes the second the least recently used.
    await store.update(first.id, owner, { title: "kept" });
    const third = await create(owner, 2);
    const listed = await store.list({ userSub: owner, limit: 50, retentionDays: 30 });
    assert.deepEqual(listed.map((c) => c.id).sort(), [first.id, third.id].sort());
    assert.equal(await store.get(second.id, owner, 30), null);
  } finally {
    await query("DELETE FROM conversations WHERE user_sub = $1", [owner]);
  }
});

test(
  "the history list pages by its cursor, and delete-all is everything",
  needsDb,
  async () => {
    const owner = unique("dave");
    for (let i = 0; i < 3; i++) await create(owner);
    const page1 = await store.list({ userSub: owner, limit: 2, retentionDays: 30 });
    assert.equal(page1.length, 2);
    const last = page1[1];
    const page2 = await store.list({
      userSub: owner,
      limit: 2,
      retentionDays: 30,
      after: { updatedAt: last.updatedAt, id: last.id },
    });
    assert.equal(page2.length, 1);
    assert.ok(!page1.some((c) => c.id === page2[0].id));
    assert.equal(await store.removeAll(owner), 3);
    assert.deepEqual(
      await store.list({ userSub: owner, limit: 2, retentionDays: 30 }),
      [],
    );
  },
);

test(
  "a conversation with nothing inside the retention window is gone",
  needsDb,
  async () => {
    const c = await create(ALICE);
    await query(
      "UPDATE conversations SET updated_at = now() - interval '40 days' WHERE id = $1",
      [c.id],
    );
    assert.equal(await store.get(c.id, ALICE, 30), null);
    // Zero days keeps it.
    assert.equal((await store.get(c.id, ALICE, 0))?.id, c.id);
    // The next conversation's sweep removes it for good.
    await create(ALICE);
    const [row] = await query<{ n: number }>(
      "SELECT count(*)::int AS n FROM conversations WHERE id = $1",
      [c.id],
    );
    assert.equal(row.n, 0);
  },
);

test("the generation log takes a chat row", needsDb, async () => {
  const [row] = await query<{ id: string }>(
    `INSERT INTO generation_log
       (workspace_id, created_by, mode, prompt_redacted, model, attempts, input_tokens, output_tokens)
     VALUES ($1, $2, 'chat', 'p', 'stub', 1, 0, 0) RETURNING id`,
    [WS, ALICE],
  );
  assert.ok(row.id);
  await query("DELETE FROM generation_log WHERE id = $1", [row.id]);
});
