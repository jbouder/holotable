import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { NextRequest } from "next/server";
import { authorizedWorkspaces, can } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";
import {
  type ShareClaims,
  shareFrameAncestors,
  shareIdentity,
  shareTokenHash,
  signShareToken,
  verifyShareToken,
} from "@/lib/auth/share";
import { resolveShare } from "@/lib/auth/share-access";
import { makeShareStore, type ShareRecord, type ShareStore } from "@/lib/db/shares";
import { Dashboard, queryTimeField } from "@/lib/ir";
import { redactString } from "@/lib/log";
import { contentSecurityPolicy, EMBED_REQUEST_HEADER } from "@/lib/security-headers";
import { ShareRequest, sharedSpec } from "@/lib/share-view";
import { proxy } from "@/proxy";

/** Read-only share links (#65). */

const SHARE = "11111111-1111-4111-8111-111111111111";
const DASH = "22222222-2222-4222-8222-222222222222";
const OTHER_DASH = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-10-04T12:00:00Z");
const DAY = 86_400_000;

const claims = (extra: Partial<ShareClaims> = {}): ShareClaims => ({
  sid: SHARE,
  did: DASH,
  exp: Math.floor((NOW + DAY) / 1000),
  org: [],
  ...extra,
});

test("a share token verifies only as signed, unexpired and well formed", async () => {
  const token = await signShareToken(claims({ org: ["https://wiki.example.com"] }));
  assert.ok(token.startsWith("hts_"));
  assert.deepEqual(
    await verifyShareToken(token, NOW),
    claims({ org: ["https://wiki.example.com"] }),
  );

  assert.equal(await verifyShareToken(token, NOW + 2 * DAY), null, "expired");
  const [payload, signature] = token.slice(4).split(".");
  const forged = Buffer.from(JSON.stringify({ ...claims(), did: OTHER_DASH })).toString(
    "base64url",
  );
  assert.equal(
    await verifyShareToken(`hts_${forged}.${signature}`, NOW),
    null,
    "re-pointed",
  );
  assert.equal(
    await verifyShareToken(`hts_${payload}.${signature}x`, NOW),
    null,
    "bad signature",
  );
  assert.equal(await verifyShareToken(`hts_${payload}`, NOW), null, "no signature");
  assert.equal(await verifyShareToken(token.slice(4), NOW), null, "no prefix");
  assert.equal(await verifyShareToken(undefined, NOW), null);
});

test("a share token and a session token are never each other", async () => {
  const share = await signShareToken(
    claims({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  );
  assert.equal(await verifySessionToken(share), null);
  const session = await signSessionToken("u1", ["/workspaces/ws/source-admin"]);
  assert.equal(await verifyShareToken(session), null);
  assert.equal(await verifyShareToken(`hts_${session}`), null);
});

const grant = { shareId: SHARE, dashboardId: DASH, workspaceId: "ws" };

test("a share identity may view its one dashboard and do nothing else", () => {
  const who = shareIdentity(grant);
  assert.equal(
    can(who, "dashboard:view", { workspaceId: "ws", dashboardId: DASH }),
    true,
  );
  assert.equal(
    can(who, "dashboard:view", { workspaceId: "ws" }),
    false,
    "unnamed dashboard",
  );
  assert.equal(
    can(who, "dashboard:view", { workspaceId: "ws", dashboardId: OTHER_DASH }),
    false,
  );
  assert.equal(
    can(who, "dashboard:view", { workspaceId: "other", dashboardId: DASH }),
    false,
  );
  for (const action of [
    "dashboard:create",
    "dashboard:update",
    "dashboard:generate",
    "dashboard:delete",
    "source:manage",
    "source:use",
    "workspace:limits",
  ] as const) {
    assert.equal(
      can(who, action, { workspaceId: "ws", dashboardId: DASH }),
      false,
      action,
    );
  }
  assert.deepEqual(authorizedWorkspaces(who, "dashboard:view"), []);

  // Nothing else on the identity widens it, an admin flag included.
  const widened: Identity = {
    ...who,
    platformAdmin: true,
    workspaces: { ws: "source-admin" },
  };
  assert.equal(
    can(widened, "dashboard:update", { workspaceId: "ws", dashboardId: DASH }),
    false,
  );
  assert.equal(can(widened, "source:use", { workspaceId: "ws" }), false);
});

function memoryStore(record: ShareRecord): ShareStore & { touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    async get(id) {
      return id === record.id ? record : null;
    },
    async list() {
      return [record];
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

async function minted(extra: Partial<ShareRecord> = {}) {
  const token = await signShareToken(claims());
  const record: ShareRecord = {
    id: SHARE,
    dashboardId: DASH,
    workspaceId: "ws",
    tokenHash: await shareTokenHash(token),
    label: null,
    allowedOrigins: [],
    timeRange: null,
    createdBy: "u1",
    createdAt: new Date(NOW - DAY).toISOString(),
    expiresAt: new Date(NOW + DAY).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    ...extra,
  };
  return { token, record };
}

test("a token is only as good as its row", async () => {
  const ok = await minted();
  const store = memoryStore(ok.record);
  const resolved = await resolveShare(ok.token, DASH, store, NOW);
  assert.equal(resolved?.identity.sub, `share:${SHARE}`);
  assert.deepEqual(resolved?.identity.share, grant);
  assert.deepEqual(store.touched, [SHARE]);

  assert.equal(
    await resolveShare(ok.token, OTHER_DASH, store, NOW),
    null,
    "another dashboard",
  );
  for (const [why, extra] of [
    ["revoked", { revokedAt: new Date(NOW - 1000).toISOString() }],
    ["row expired", { expiresAt: new Date(NOW - 1000).toISOString() }],
    ["another token minted for the row", { tokenHash: "0".repeat(64) }],
    ["row for another dashboard", { dashboardId: OTHER_DASH }],
  ] as const) {
    const bad = await minted(extra);
    assert.equal(
      await resolveShare(bad.token, DASH, memoryStore(bad.record), NOW),
      null,
      why,
    );
  }
  const gone = await minted();
  const empty: ShareStore = { ...memoryStore(gone.record), get: async () => null };
  assert.equal(await resolveShare(gone.token, DASH, empty, NOW), null, "no row");
});

test("an embed may be framed only by the origins its token names", async () => {
  assert.equal(shareFrameAncestors(null), "'none'");
  assert.equal(shareFrameAncestors(claims()), "'none'");
  assert.equal(
    shareFrameAncestors(
      claims({
        org: ["https://a.example.com", "https://b.example.com:8443", "javascript:x"],
      }),
    ),
    "https://a.example.com https://b.example.com:8443",
  );
  assert.match(
    contentSecurityPolicy({
      nonce: "n",
      development: false,
      frameAncestors: "https://a.example.com",
    }),
    /frame-ancestors https:\/\/a\.example\.com/,
  );
  assert.match(
    contentSecurityPolicy({ nonce: "n", development: false }),
    /frame-ancestors 'none'/,
  );

  const token = await signShareToken(
    claims({
      exp: Math.floor(Date.now() / 1000) + 3600,
      org: ["https://wiki.example.com"],
    }),
  );
  const embed = await proxy(
    new NextRequest(`http://localhost/embed/dashboards/${DASH}?token=${token}`),
  );
  assert.match(
    embed.headers.get("content-security-policy") ?? "",
    /frame-ancestors https:\/\/wiki\.example\.com/,
  );
  assert.equal(embed.headers.get(`x-middleware-request-${EMBED_REQUEST_HEADER}`), "1");

  const tampered = await proxy(
    new NextRequest(`http://localhost/embed/dashboards/${DASH}?token=${token}x`),
  );
  assert.match(
    tampered.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );

  // A request cannot mark itself as an embed to drop the app's chrome.
  const forged = await proxy(
    new NextRequest("http://localhost/dashboards", {
      headers: { [EMBED_REQUEST_HEADER]: "1" },
    }),
  );
  assert.notEqual(
    forged.headers.get(`x-middleware-request-${EMBED_REQUEST_HEADER}`),
    "1",
  );
  assert.match(
    forged.headers.get("content-security-policy") ?? "",
    /frame-ancestors 'none'/,
  );
});

test("what an editor may ask a share for is checked", () => {
  const ok = { expiresInDays: 30, allowedOrigins: ["https://wiki.example.com"] };
  assert.ok(ShareRequest.safeParse(ok).success);
  for (const bad of [
    { ...ok, expiresInDays: 91 },
    { ...ok, expiresInDays: 0 },
    { ...ok, allowedOrigins: ["https://wiki.example.com/page"] },
    { ...ok, allowedOrigins: ["https://*.example.com"] },
    { ...ok, allowedOrigins: ["http://wiki.example.com"] },
    { ...ok, allowedOrigins: ["javascript:alert(1)"] },
    { ...ok, allowedOrigins: ["https://a.example.com 'unsafe-inline'"] },
    { ...ok, workspaceId: "other" },
  ]) {
    assert.equal(ShareRequest.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a share link's page is sent no SQL, no source ids and no variables", () => {
  const spec = Dashboard.parse({
    specVersion: 1,
    title: "t",
    timeRange: { from: "now-1h", to: "now" },
    refreshIntervalMs: 60_000,
    variables: [{ name: "env", type: "enum", values: ["prod"] }],
    panels: [
      {
        id: "p",
        title: "p",
        viz: "line",
        query: {
          sourceId: "secret-source",
          sql: "SELECT ts, v FROM private_table",
          timeField: "ts",
        },
        layout: { x: 0, y: 0, w: 6, h: 4 },
      },
    ],
  });
  const shared = sharedSpec(spec, { from: "now-24h", to: "now" });
  const text = JSON.stringify(shared);
  assert.equal(text.includes("private_table"), false);
  assert.equal(text.includes("secret-source"), false);
  assert.equal("variables" in shared, false);
  assert.equal(
    shared.panels[0].query ? queryTimeField(shared.panels[0].query) : undefined,
    "ts",
  );
  assert.deepEqual(shared.timeRange, { from: "now-24h", to: "now" });
});

test("a share token never reaches a log line", async () => {
  const token = await signShareToken(claims());
  assert.equal(
    redactString(`GET /api/dashboards/x/stream?share=${token}`).includes(token),
    false,
  );
});

test("only the stream route and the embed page accept a share token", () => {
  const root = new URL("../src/app", import.meta.url).pathname;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.(ts|tsx)$/.test(entry) &&
        readFileSync(path, "utf8").includes("resolveShare")
      ) {
        found.push(path.slice(root.length));
      }
    }
  };
  walk(root);
  assert.deepEqual(found.sort(), [
    "/api/dashboards/[id]/stream/route.ts",
    "/embed/dashboards/[id]/page.tsx",
  ]);
  const authorize = readFileSync(
    new URL("../src/lib/auth/authorize.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    /share/i.test(
      authorize.slice(authorize.indexOf("export async function getIdentity")),
    ),
    false,
  );
});

/* Against a real server: a share row is only ever read and revoked for its own dashboard. */

const dbUrl = process.env.MIGRATE_TEST_DATABASE_URL;

test("a share row is revoked only through its own dashboard and workspace", {
  skip: dbUrl ? false : "run with npm run test:integration (needs Docker)",
}, async () => {
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  const schema = `shares_test_${process.pid}`;
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    const migration = readFileSync(
      new URL("../migrations/014_dashboard_shares.sql", import.meta.url),
      "utf8",
    );
    await client.query(migration.split(/^-- rollback:/m)[0]);
    const store = makeShareStore(
      async (text, params) => (await client.query(text, params as unknown[])).rows,
    );
    const created = await store.create({
      id: SHARE,
      dashboardId: DASH,
      workspaceId: "ws",
      tokenHash: "a".repeat(64),
      label: "wall",
      allowedOrigins: ["https://wiki.example.com"],
      timeRange: { from: "now-24h", to: "now" },
      createdBy: "u1",
      expiresAt: new Date(NOW + DAY).toISOString(),
    });
    assert.deepEqual(created.timeRange, { from: "now-24h", to: "now" });
    assert.equal(
      (await store.list({ dashboardId: DASH, workspaceId: "other" })).length,
      0,
    );
    assert.equal(
      await store.revoke({ id: SHARE, dashboardId: OTHER_DASH, workspaceId: "ws" }),
      false,
    );
    assert.equal(
      await store.revoke({ id: SHARE, dashboardId: DASH, workspaceId: "other" }),
      false,
    );
    assert.equal((await store.get(SHARE))?.revokedAt, null);
    assert.equal(
      await store.revoke({ id: SHARE, dashboardId: DASH, workspaceId: "ws" }),
      true,
    );
    assert.notEqual((await store.get(SHARE))?.revokedAt, null);
    assert.equal(
      await store.revoke({ id: SHARE, dashboardId: DASH, workspaceId: "ws" }),
      false,
      "once",
    );
    await store.touch(SHARE);
    assert.notEqual((await store.get(SHARE))?.lastUsedAt, null);
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
