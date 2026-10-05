import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Client } from "pg";
import {
  apiTokenHash,
  apiTokenIdentity,
  bearerApiToken,
  generateApiToken,
  resolveApiToken,
} from "@/lib/auth/api-token";
import { authorizedWorkspaces, can } from "@/lib/auth/authorize";
import { parseGroups } from "@/lib/auth/claims";
import { apiTokenRequest } from "@/lib/api-token-view";
import {
  type ApiTokenRecord,
  type ApiTokenStore,
  makeApiTokenStore,
} from "@/lib/db/api-tokens";
import { visibleSections } from "@/lib/settings";

/** Service-account API tokens (#288). */

const NOW = Date.parse("2026-10-05T12:00:00Z");
const DAY = 86_400_000;
const ID = "44444444-4444-4444-8444-444444444444";

test("a token is 32 random bytes behind ht_, and only a bearer header carries one", () => {
  const a = generateApiToken();
  const b = generateApiToken();
  assert.match(a, /^ht_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(bearerApiToken(`Bearer ${a}`), a);
  assert.equal(bearerApiToken(`bearer   ${a}`), a);
  for (const header of [
    null,
    "",
    a,
    `Basic ${a}`,
    `Bearer ${a} extra`,
    `Bearer ${a.slice(0, -1)}`,
    "Bearer eyJhbGciOiJIUzI1NiJ9.e30.x",
    `Bearer hts_${a.slice(3)}`,
  ]) {
    assert.equal(bearerApiToken(header), null, String(header));
  }
});

function record(extra: Partial<ApiTokenRecord> = {}): ApiTokenRecord {
  return {
    id: ID,
    workspaceId: "ws",
    name: "deploy pipeline",
    tokenHash: "",
    role: "editor",
    createdBy: "u1",
    createdAt: new Date(NOW - DAY).toISOString(),
    expiresAt: new Date(NOW + DAY).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    ...extra,
  };
}

function memoryStore(rows: ApiTokenRecord[]): ApiTokenStore & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    async byHash(hash) {
      return rows.find((r) => r.tokenHash === hash) ?? null;
    },
    async list() {
      return rows;
    },
    async create() {
      throw new Error("unused");
    },
    async revoke() {
      return false;
    },
    async touch(id) {
      touched.push(id);
    },
  };
}

test("a token resolves to its one workspace at its role, while it is live", async () => {
  const token = generateApiToken();
  const hash = await apiTokenHash(token);
  const store = memoryStore([record({ tokenHash: hash })]);
  const identity = await resolveApiToken(token, store, NOW);
  assert.deepEqual(identity, {
    sub: `token:${ID}`,
    platformAdmin: false,
    workspaces: { ws: "editor" },
    serviceAccount: { tokenId: ID, name: "deploy pipeline" },
  });
  assert.deepEqual(store.touched, [ID]);

  for (const [why, extra] of [
    ["revoked", { revokedAt: new Date(NOW - 1000).toISOString() }],
    ["expired", { expiresAt: new Date(NOW - 1000).toISOString() }],
    ["a role no token may hold", { role: "source-admin" as never }],
  ] as const) {
    const bad = memoryStore([record({ tokenHash: hash, ...extra })]);
    assert.equal(await resolveApiToken(token, bad, NOW), null, why);
  }
  assert.equal(await resolveApiToken(generateApiToken(), store, NOW), null, "unknown");
  assert.equal(await resolveApiToken("ht_short", store, NOW), null, "malformed");
});

test("can() decides a token's request as for a person with its one role", () => {
  const editor = apiTokenIdentity(record());
  assert.equal(can(editor, "dashboard:update", { workspaceId: "ws" }), true);
  assert.equal(can(editor, "dashboard:view", { workspaceId: "ws" }), true);
  assert.equal(can(editor, "dashboard:update", { workspaceId: "other" }), false);
  assert.equal(can(editor, "source:manage", { workspaceId: "ws" }), false);
  assert.equal(can(editor, "workspace:limits", { workspaceId: "ws" }), false);
  assert.deepEqual(authorizedWorkspaces(editor, "dashboard:view"), ["ws"]);

  const viewer = apiTokenIdentity(record({ role: "viewer" }));
  assert.equal(can(viewer, "dashboard:view", { workspaceId: "ws" }), true);
  assert.equal(can(viewer, "dashboard:update", { workspaceId: "ws" }), false);
  assert.throws(() => apiTokenIdentity(record({ role: "source-admin" as never })));
});

test("what an admin may ask a token for is checked", () => {
  const schema = apiTokenRequest(90);
  assert.ok(schema.safeParse({ name: "ci", role: "editor", expiresInDays: 90 }).success);
  for (const bad of [
    { name: "ci", role: "source-admin", expiresInDays: 30 },
    { name: "ci", role: "editor", expiresInDays: 91 },
    { name: "ci", role: "editor", expiresInDays: 0 },
    { name: " ", role: "editor", expiresInDays: 30 },
    { name: "ci", role: "editor", expiresInDays: 30, workspaceId: "other" },
  ]) {
    assert.equal(schema.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("the tokens section is for someone who manages a workspace", () => {
  const ids = (groups: string[]) =>
    visibleSections(parseGroups("u", groups)).map((s) => s.id);
  assert.ok(!ids(["/workspaces/w/editor"]).includes("tokens"));
  assert.ok(ids(["/workspaces/w/source-admin"]).includes("tokens"));
  // A token never manages tokens: no role it can hold reaches `source:manage`.
  assert.equal(
    visibleSections(apiTokenIdentity(record())).some((s) => s.id === "tokens"),
    false,
  );
});

test("a token cannot open a dashboard stream", () => {
  const stream = readFileSync(
    new URL("../src/app/api/dashboards/[id]/stream/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(stream, /if \(identity\.serviceAccount\) \{\s+throw new HttpError\(403/);
});

/* Against a real server: a token is found by its hash and revoked only in its workspace. */

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("a token row is found by hash and revoked only in its own workspace", {
  skip: dbUrl ? false : "set MIGRATE_TEST_DATABASE_URL to run",
}, async () => {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const schema = `api_tokens_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    const migration = readFileSync(
      new URL("../migrations/015_api_tokens.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration.split(/^-- rollback:/m)[0]);
    const store = makeApiTokenStore(
      async (text, params) => (await client.query(text, params as unknown[])).rows,
    );
    const token = generateApiToken();
    const created = await store.create({
      workspaceId: "ws",
      name: "ci",
      tokenHash: await apiTokenHash(token),
      role: "editor",
      createdBy: "u1",
      expiresAt: new Date(Date.now() + DAY).toISOString(),
    });
    assert.equal((await resolveApiToken(token, store))?.sub, `token:${created.id}`);
    assert.equal(await store.revoke({ id: created.id, workspaceId: "other" }), false);
    assert.notEqual(await resolveApiToken(token, store), null);
    assert.equal(await store.revoke({ id: created.id, workspaceId: "ws" }), true);
    assert.equal(await resolveApiToken(token, store), null, "refused at once");
    await assert.rejects(
      client.query(
        "INSERT INTO api_tokens (workspace_id, name, token_hash, role, created_by, expires_at) VALUES ('ws', 'x', 'h', 'source-admin', 'u', now())",
      ),
      /check/i,
    );
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
