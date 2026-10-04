import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { parseGroups, type Identity } from "@/lib/auth/claims";
import {
  OidcGrantRefused,
  readTokenSet,
  refreshTokens,
  type TokenSet,
} from "@/lib/auth/oidc";
import {
  hashSessionId,
  newSessionId,
  openRefreshToken,
  sealRefreshToken,
} from "@/lib/auth/refresh-token";
import {
  endSession,
  groupsOf,
  type LockedSession,
  type RenewalDeps,
  RENEWABLE_TTL_SECONDS,
  renewSession,
  type SessionStore,
  sessionLifetimes,
  startSession,
  type StoredSession,
  UNRENEWABLE_TTL_SECONDS,
} from "@/lib/auth/renewal";
import {
  signSessionToken,
  tokenExpiry,
  tokenRef,
  verifySessionToken,
} from "@/lib/auth/session";
import { readRenewResponse, renewalDelay } from "@/lib/session-renewal";

/**
 * Session renewal (#27): the refresh token at rest, the lifetimes, and every
 * way a renewal can end — with the database and the realm replaced by fakes.
 */

/* -------------------------------------------------------------------------- */
/* The refresh token at rest                                                  */
/* -------------------------------------------------------------------------- */

const SECRET = new TextEncoder().encode("a".repeat(16) + "b".repeat(16) + "c".repeat(8));
const OTHER = new TextEncoder().encode("z".repeat(40));

test("a sealed refresh token opens with the same secret, and never contains it in clear", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.refresh-token-body.signature";
  const sealed = sealRefreshToken(token, SECRET);
  assert.equal(sealed.includes(Buffer.from(token)), false);
  assert.equal(sealed.includes(Buffer.from("refresh-token-body")), false);
  assert.equal(openRefreshToken(sealed, SECRET), token);
});

test("sealing twice gives different bytes (a fresh IV each time)", () => {
  const a = sealRefreshToken("same", SECRET);
  const b = sealRefreshToken("same", SECRET);
  assert.notDeepEqual(a, b);
});

test("a token sealed under another secret, or edited at rest, does not open", () => {
  const sealed = sealRefreshToken("token", SECRET);
  assert.equal(openRefreshToken(sealed, OTHER), null);

  const edited = Buffer.from(sealed);
  edited[edited.length - 1] ^= 0x01;
  assert.equal(openRefreshToken(edited, SECRET), null);

  assert.equal(openRefreshToken(Buffer.alloc(0), SECRET), null);
  assert.equal(openRefreshToken(sealed.subarray(0, 20), SECRET), null);
});

test("a session id is long and random, and the table never holds it", () => {
  const id = newSessionId();
  assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(newSessionId(), id);
  const hash = hashSessionId(id);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(hash.includes(id), false);
  assert.equal(hashSessionId(id), hash);
});

/* -------------------------------------------------------------------------- */
/* Lifetimes                                                                  */
/* -------------------------------------------------------------------------- */

test("a renewable token lives half the refresh token's life, within bounds", () => {
  // A default Keycloak realm: 30 minutes idle.
  assert.deepEqual(sessionLifetimes(1800), { tokenTtl: 900, rowTtl: 1800 });
  // Near the realm's maximum lifespan the window shrinks, but not below a minute.
  assert.deepEqual(sessionLifetimes(90), { tokenTtl: 60, rowTtl: 90 });
  // A very long refresh lifetime is still capped at the old eight hours.
  assert.equal(sessionLifetimes(7 * 24 * 3600).tokenTtl, UNRENEWABLE_TTL_SECONDS);
  // No idle limit reported (Keycloak sends 0 for offline tokens).
  assert.equal(sessionLifetimes(0).tokenTtl, RENEWABLE_TTL_SECONDS);
  assert.equal(sessionLifetimes(undefined).tokenTtl, RENEWABLE_TTL_SECONDS);
});

test("the groups a token carries round-trip through the claims parser", () => {
  const groups = [
    "/workspaces/ops/editor",
    "/workspaces/demo/viewer",
    "/platform-admins",
  ];
  const identity = parseGroups("u1", groups);
  assert.deepEqual(new Set(groupsOf(identity)), new Set(groups));
});

/* -------------------------------------------------------------------------- */
/* Fakes                                                                      */
/* -------------------------------------------------------------------------- */

interface Row extends StoredSession {
  oidcSid: string | null;
}

function memoryStore(): SessionStore & { rows: Map<string, Row>; failCreate?: boolean } {
  const rows = new Map<string, Row>();
  const store = {
    rows,
    failCreate: false,
    async create(row: {
      idHash: string;
      sub: string;
      oidcSid: string | null;
      refreshToken: Buffer;
      expiresAt: Date;
    }) {
      if (store.failCreate) throw new Error("database is down");
      rows.set(row.idHash, {
        sub: row.sub,
        oidcSid: row.oidcSid,
        refreshToken: row.refreshToken,
        expiresAt: row.expiresAt,
      });
    },
    async withLocked<T>(idHash: string, fn: (s: LockedSession) => Promise<T>) {
      const row = rows.get(idHash) ?? null;
      return fn({
        row,
        async update(next) {
          const cur = rows.get(idHash);
          if (cur) rows.set(idHash, { ...cur, ...next });
        },
        async remove() {
          rows.delete(idHash);
        },
      });
    },
    async remove(idHash: string) {
      rows.delete(idHash);
    },
  };
  return store;
}

/** An id_token is just a key into what the fake realm says about it. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64(claims)}.`;
}

const NOW = 1_800_000_000_000;

function deps(
  store: SessionStore,
  realm: {
    refresh?: (rt: string) => Promise<TokenSet>;
    identities?: Map<string, Identity>;
  } = {},
): RenewalDeps & { refreshed: string[] } {
  const refreshed: string[] = [];
  return {
    refreshed,
    store,
    now: () => NOW,
    async refreshTokens(rt) {
      refreshed.push(rt);
      if (!realm.refresh) throw new Error("no realm");
      return realm.refresh(rt);
    },
    async verifyIdToken(idToken) {
      return realm.identities?.get(idToken) ?? null;
    },
    signSessionToken,
  };
}

const alice = parseGroups("alice", ["/workspaces/ops/editor"]);

async function signedIn(store: ReturnType<typeof memoryStore>, refreshExpiresIn = 1800) {
  const issued = await startSession(deps(store), alice, {
    id_token: unsignedJwt({ sub: "alice", sid: "kc-session-1" }),
    refresh_token: "rt-1",
    refresh_expires_in: refreshExpiresIn,
  });
  assert.ok(issued.renewal);
  return issued;
}

/* -------------------------------------------------------------------------- */
/* Sign-in                                                                    */
/* -------------------------------------------------------------------------- */

test("sign-in with a refresh token stores it sealed and issues a short, renewable token", async () => {
  const store = memoryStore();
  const issued = await signedIn(store);

  assert.equal(issued.tokenTtl, 900);
  assert.equal(issued.expiresAt, NOW + 900_000);
  assert.equal(issued.renewal?.ttl, 1800);

  const [[idHash, row]] = [...store.rows];
  assert.equal(idHash, hashSessionId(issued.renewal?.sessionId ?? ""));
  assert.equal(row.sub, "alice");
  assert.equal(row.oidcSid, "kc-session-1");
  assert.equal(row.expiresAt.getTime(), NOW + 1_800_000);
  assert.equal(Buffer.from(row.refreshToken).includes(Buffer.from("rt-1")), false);
  assert.equal(openRefreshToken(row.refreshToken), "rt-1");

  // It names the realm session, so a back-channel logout can reach it (#28).
  assert.equal(tokenRef(issued.sessionToken)?.sid, "kc-session-1");

  // The token is an ordinary session token, verified the ordinary way.
  const identity = await verifySessionToken(issued.sessionToken);
  assert.equal(identity?.sub, "alice");
  assert.equal(identity?.workspaces.ops, "editor");
});

test("without a refresh token, or without a database, sign-in is the old eight hours", async () => {
  const store = memoryStore();
  const plain = await startSession(deps(store), alice, { id_token: "x" });
  assert.equal(plain.tokenTtl, UNRENEWABLE_TTL_SECONDS);
  assert.equal(plain.renewal, undefined);

  store.failCreate = true;
  const down = await startSession(deps(store), alice, {
    id_token: "x",
    refresh_token: "rt",
  });
  assert.equal(down.tokenTtl, UNRENEWABLE_TTL_SECONDS);
  assert.equal(down.renewal, undefined);
  assert.equal(store.rows.size, 0);
  assert.ok(await verifySessionToken(down.sessionToken));
});

/* -------------------------------------------------------------------------- */
/* Renewal                                                                    */
/* -------------------------------------------------------------------------- */

test("a renewal re-derives the groups from the realm's fresh id_token", async () => {
  const store = memoryStore();
  const issued = await signedIn(store);
  // Since sign-in, alice lost `ops` and was given viewer on `demo`.
  const fresh = parseGroups("alice", ["/workspaces/demo/viewer"]);
  const d = deps(store, {
    refresh: async () => ({
      id_token: "id-2",
      refresh_token: "rt-2",
      refresh_expires_in: 1800,
    }),
    identities: new Map([["id-2", fresh]]),
  });

  const outcome = await renewSession(d, issued.renewal?.sessionId ?? "");
  assert.ok(outcome.ok);
  assert.deepEqual(d.refreshed, ["rt-1"]);

  const identity = await verifySessionToken(outcome.sessionToken);
  assert.equal(identity?.workspaces.ops, undefined, "the removed role is gone");
  assert.equal(identity?.workspaces.demo, "viewer");
  assert.equal(tokenExpiry(outcome.sessionToken) !== null, true);
  assert.equal(outcome.expiresAt, NOW + 900_000);

  // The rotated refresh token replaced the old one, still sealed.
  // The fresh id_token carried no `sid`; the one from sign-in still names it.
  assert.equal(tokenRef(outcome.sessionToken)?.sid, "kc-session-1");

  const row = [...store.rows.values()][0];
  assert.equal(openRefreshToken(row.refreshToken), "rt-2");
  assert.equal(row.expiresAt.getTime(), NOW + 1_800_000);
});

test("a realm that does not rotate keeps the refresh token it already had", async () => {
  const store = memoryStore();
  const issued = await signedIn(store);
  const d = deps(store, {
    refresh: async () => ({ id_token: "id-2" }),
    identities: new Map([["id-2", alice]]),
  });
  assert.ok((await renewSession(d, issued.renewal?.sessionId ?? "")).ok);
  assert.equal(openRefreshToken([...store.rows.values()][0].refreshToken), "rt-1");
});

test("a refusal from the realm ends the session and forgets the token", async () => {
  const store = memoryStore();
  const issued = await signedIn(store);
  const d = deps(store, {
    refresh: async () => {
      throw new OidcGrantRefused("invalid_grant");
    },
  });
  assert.deepEqual(await renewSession(d, issued.renewal?.sessionId ?? ""), {
    ok: false,
    reason: "ended",
  });
  assert.equal(store.rows.size, 0);
});

test("a realm that cannot be reached is not an ended session", async () => {
  const store = memoryStore();
  const issued = await signedIn(store);
  const d = deps(store, {
    refresh: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.deepEqual(await renewSession(d, issued.renewal?.sessionId ?? ""), {
    ok: false,
    reason: "unavailable",
  });
  assert.equal(store.rows.size, 1, "a transient failure keeps the session");
});

test("an unknown, expired or unreadable session is ended without asking the realm", async () => {
  const store = memoryStore();
  const d = deps(store, { refresh: async () => ({ id_token: "never" }) });

  assert.deepEqual(await renewSession(d, "no-such-session"), {
    ok: false,
    reason: "ended",
  });

  const issued = await signedIn(store);
  const id = issued.renewal?.sessionId ?? "";
  const hash = hashSessionId(id);
  const row = store.rows.get(hash);
  assert.ok(row);
  store.rows.set(hash, { ...row, expiresAt: new Date(NOW) });
  assert.deepEqual(await renewSession(d, id), { ok: false, reason: "ended" });
  assert.equal(store.rows.size, 0);

  const again = await signedIn(store);
  const againHash = hashSessionId(again.renewal?.sessionId ?? "");
  const againRow = store.rows.get(againHash);
  assert.ok(againRow);
  store.rows.set(againHash, { ...againRow, refreshToken: sealRefreshToken("rt", OTHER) });
  assert.deepEqual(await renewSession(d, again.renewal?.sessionId ?? ""), {
    ok: false,
    reason: "ended",
  });

  assert.deepEqual(d.refreshed, [], "the realm was never asked");
});

test("an id_token that does not verify, or names someone else, ends the session", async () => {
  for (const identities of [
    new Map<string, Identity>(),
    new Map([["id-2", parseGroups("mallory", ["/platform-admins"])]]),
  ]) {
    const store = memoryStore();
    const issued = await signedIn(store);
    const d = deps(store, {
      refresh: async () => ({ id_token: "id-2", refresh_token: "rt-2" }),
      identities,
    });
    assert.deepEqual(await renewSession(d, issued.renewal?.sessionId ?? ""), {
      ok: false,
      reason: "ended",
    });
    assert.equal(store.rows.size, 0);
  }
});

test("signing out removes the stored token", async () => {
  const store = memoryStore();
  const issued = await signedIn(store);
  await endSession(deps(store), issued.renewal?.sessionId ?? "");
  assert.equal(store.rows.size, 0);
});

/* -------------------------------------------------------------------------- */
/* The token endpoint                                                         */
/* -------------------------------------------------------------------------- */

test("a token response is read for its shape only", () => {
  assert.deepEqual(
    readTokenSet({
      id_token: "id",
      refresh_token: "rt",
      refresh_expires_in: 1800,
      access_token: "ignored",
    }),
    { id_token: "id", refresh_token: "rt", refresh_expires_in: 1800 },
  );
  assert.deepEqual(
    readTokenSet({ id_token: "id", refresh_token: "", refresh_expires_in: -1 }),
    {
      id_token: "id",
    },
  );
  assert.throws(() => readTokenSet({ refresh_token: "rt" }));
  assert.throws(() => readTokenSet(null));
});

const realFetch = globalThis.fetch;
const savedEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = realFetch;
  process.env = { ...savedEnv };
});

test("a refresh is a refresh_token grant, and a 400 is a refusal rather than an outage", async () => {
  // Discovery is cached per process; this file is the only caller in its own.
  process.env.OIDC_ISSUER = "https://realm.example/realms/holotable";
  process.env.OIDC_CLIENT_ID = "holotable";
  process.env.OIDC_CLIENT_SECRET = "client-secret";
  const posted: URLSearchParams[] = [];
  let status = 200;
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    if (String(input).endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        token_endpoint: "https://realm.example/token",
        authorization_endpoint: "https://realm.example/auth",
        jwks_uri: "https://realm.example/jwks",
        issuer: "https://realm.example/realms/holotable",
      });
    }
    posted.push(new URLSearchParams(String(init?.body)));
    return status === 200
      ? Response.json({ id_token: "id", refresh_token: "rt-2", refresh_expires_in: 600 })
      : new Response('{"error":"invalid_grant"}', { status });
  }) as typeof fetch;

  assert.deepEqual(await refreshTokens("rt-1"), {
    id_token: "id",
    refresh_token: "rt-2",
    refresh_expires_in: 600,
  });
  assert.equal(posted[0].get("grant_type"), "refresh_token");
  assert.equal(posted[0].get("refresh_token"), "rt-1");
  assert.equal(posted[0].get("client_id"), "holotable");
  assert.equal(posted[0].get("client_secret"), "client-secret");

  status = 400;
  await assert.rejects(refreshTokens("rt-1"), OidcGrantRefused);
  status = 503;
  await assert.rejects(
    refreshTokens("rt-1"),
    (err) => !(err instanceof OidcGrantRefused),
  );
});

/* -------------------------------------------------------------------------- */
/* The browser's schedule                                                     */
/* -------------------------------------------------------------------------- */

test("the browser renews a minute early, or a quarter early for a short token", () => {
  assert.equal(renewalDelay(NOW + 15 * 60_000, NOW), 14 * 60_000);
  assert.equal(renewalDelay(NOW + 60_000, NOW), 45_000);
  // Never in a tight loop, and immediately once already expired.
  assert.equal(renewalDelay(NOW + 8_000, NOW), 6_000);
  assert.equal(renewalDelay(NOW + 2_000, NOW), 2_000);
  assert.equal(renewalDelay(NOW, NOW), 0);
  assert.equal(renewalDelay(NOW - 5_000, NOW), 0);
});

test("only a 401 means the session is over", async () => {
  assert.deepEqual(await readRenewResponse(Response.json({ expiresAt: 42 })), {
    ok: true,
    expiresAt: 42,
  });
  assert.deepEqual(await readRenewResponse(new Response("", { status: 401 })), {
    ok: false,
    ended: true,
  });
  for (const status of [404, 500, 503]) {
    assert.deepEqual(await readRenewResponse(new Response("", { status })), {
      ok: false,
      ended: false,
    });
  }
  assert.deepEqual(await readRenewResponse(Response.json({})), {
    ok: false,
    ended: false,
  });
});
