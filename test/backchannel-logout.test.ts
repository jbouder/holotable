import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";
import { BACKCHANNEL_LOGOUT_EVENT, verifyLogoutToken } from "@/lib/auth/backchannel";
import {
  isRevoked,
  onRevoke,
  REVOCATION_HOLD_MS,
  resetRevocations,
  revoke,
} from "@/lib/auth/revocation";
import { signSessionToken, tokenRef, verifySessionToken } from "@/lib/auth/session";
import { SESSION_ENDED_EVENT, sessionEndedFrame } from "@/lib/sse";

/**
 * Back-channel logout (#28): which tokens a revocation reaches, and what a
 * logout token has to be before the endpoint believes it.
 */

beforeEach(() => resetRevocations());

const NOW = 1_800_000_000_000;
const sec = (ms: number) => Math.floor(ms / 1000);

/* -------------------------------------------------------------------------- */
/* Revocation                                                                 */
/* -------------------------------------------------------------------------- */

test("revoking a realm session reaches its tokens and no other session's", () => {
  revoke({ sub: "alice", sid: "kc-1" }, NOW);
  assert.equal(isRevoked({ sub: "alice", sid: "kc-1", iat: sec(NOW) - 60 }, NOW), true);
  // The same person on another device keeps their session.
  assert.equal(isRevoked({ sub: "alice", sid: "kc-2", iat: sec(NOW) - 60 }, NOW), false);
  // A token from before tokens carried `sid` cannot be told apart, so it goes.
  assert.equal(isRevoked({ sub: "alice", sid: null, iat: sec(NOW) - 60 }, NOW), true);
  assert.equal(isRevoked({ sub: "bob", sid: null, iat: sec(NOW) - 60 }, NOW), false);
});

test("revoking a subject alone reaches every token issued until then", () => {
  revoke({ sub: "alice" }, NOW);
  assert.equal(isRevoked({ sub: "alice", sid: "kc-1", iat: sec(NOW) - 60 }, NOW), true);
  assert.equal(isRevoked({ sub: "alice", sid: null, iat: sec(NOW) }, NOW), true);
  // Signing in again afterwards works.
  assert.equal(
    isRevoked({ sub: "alice", sid: "kc-3", iat: sec(NOW) + 1 }, NOW + 1500),
    false,
  );
});

test("a narrower revocation later does not move a broad one forward", () => {
  revoke({ sub: "alice" }, NOW);
  const later = NOW + 60_000;
  // Alice signs in again (kc-2), then a different session of hers (kc-9) ends.
  revoke({ sub: "alice", sid: "kc-9" }, later + 10_000);
  assert.equal(
    isRevoked({ sub: "alice", sid: "kc-2", iat: sec(later) }, later + 10_000),
    false,
    "the new session survives",
  );
  assert.equal(isRevoked({ sub: "alice", sid: "kc-1", iat: sec(NOW) - 5 }, later), true);
});

test("an entry is forgotten once no token could still carry it", () => {
  revoke({ sub: "alice", sid: "kc-1" }, NOW);
  const ref = { sub: "alice", sid: "kc-1", iat: sec(NOW) - 60 };
  assert.equal(isRevoked(ref, NOW + REVOCATION_HOLD_MS - 1), true);
  assert.equal(isRevoked(ref, NOW + REVOCATION_HOLD_MS), false);
});

test("listeners hear every revocation and can stop listening", () => {
  let heard = 0;
  const stop = onRevoke(() => {
    heard++;
  });
  onRevoke(() => {
    throw new Error("a broken stream");
  });
  revoke({ sid: "kc-1" }, NOW);
  revoke({}, NOW); // names nothing: not a revocation
  stop();
  revoke({ sid: "kc-2" }, NOW);
  assert.equal(heard, 1);
});

test("a revoked session token stops verifying on the next request", async () => {
  const token = await signSessionToken(
    "alice",
    ["/workspaces/ops/viewer"],
    {},
    900,
    "kc-1",
  );
  assert.deepEqual(tokenRef(token)?.sid, "kc-1");
  assert.equal((await verifySessionToken(token))?.sub, "alice");

  revoke({ sub: "alice", sid: "kc-1" });
  assert.equal(await verifySessionToken(token), null);

  // Her session on another device is untouched.
  const other = await signSessionToken(
    "alice",
    ["/workspaces/ops/viewer"],
    {},
    900,
    "kc-2",
  );
  assert.equal((await verifySessionToken(other))?.sub, "alice");
});

test("the stream's terminal frame is a named event, never a poller event", () => {
  const frame = sessionEndedFrame();
  assert.match(frame, new RegExp(`^event: ${SESSION_ENDED_EVENT}\\n`));
  assert.match(frame, /\ndata: \{"reason":"revoked"\}\n\n$/);
  assert.doesNotMatch(frame, /retry:/);
});

/* -------------------------------------------------------------------------- */
/* The logout token                                                           */
/* -------------------------------------------------------------------------- */

const ISSUER = "http://localhost:8080/realms/holotable";
const CLIENT = "holotable";

// Generated once; `.ts` tests run as CommonJS here, so no top-level await.
const fixture = (async () => {
  const realm = await generateKeyPair("RS256");
  const stranger = await generateKeyPair("RS256");
  const publicJwk: JWK = {
    ...(await exportJWK(realm.publicKey)),
    kid: "realm",
    alg: "RS256",
  };
  return { realm, stranger, publicJwk, keys: createLocalJWKSet({ keys: [publicJwk] }) };
})();
const opts = { issuer: ISSUER, audience: CLIENT };

async function logoutToken(
  claims: Record<string, unknown> = {},
  sign: { key?: CryptoKey; issuer?: string; audience?: string; iat?: number } = {},
) {
  const { realm } = await fixture;
  return new SignJWT({
    sub: "alice",
    sid: "kc-1",
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    jti: "j-1",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "realm", typ: "logout+jwt" })
    .setIssuer(sign.issuer ?? ISSUER)
    .setAudience(sign.audience ?? CLIENT)
    .setIssuedAt(sign.iat)
    .sign(sign.key ?? realm.privateKey);
}

test("a logout token from the realm, for this client, names who to sign out", async () => {
  const { keys } = await fixture;
  assert.deepEqual(await verifyLogoutToken(await logoutToken(), keys, opts), {
    sub: "alice",
    sid: "kc-1",
  });
  assert.deepEqual(
    await verifyLogoutToken(await logoutToken({ sid: undefined }), keys, opts),
    { sub: "alice" },
  );
  assert.deepEqual(
    await verifyLogoutToken(await logoutToken({ sub: undefined }), keys, opts),
    { sid: "kc-1" },
  );
});

test("anything else is refused", async () => {
  const { keys, stranger, publicJwk } = await fixture;
  const cases: [string, Promise<string>][] = [
    ["signed by another key", logoutToken({}, { key: stranger.privateKey })],
    ["another issuer", logoutToken({}, { issuer: "https://evil.example/realms/x" })],
    ["another client", logoutToken({}, { audience: "some-other-client" })],
    ["too old to replay", logoutToken({}, { iat: sec(Date.now()) - 600 })],
    ["no events claim", logoutToken({ events: undefined })],
    ["the wrong event", logoutToken({ events: { "http://example.com/other": {} } })],
    [
      "an event that is not an object",
      logoutToken({ events: { [BACKCHANNEL_LOGOUT_EVENT]: 1 } }),
    ],
    ["events as an array", logoutToken({ events: [BACKCHANNEL_LOGOUT_EVENT] })],
    // An id_token from the same realm is signed by the same keys.
    ["a nonce, as an id_token has", logoutToken({ nonce: "n" })],
    ["neither sub nor sid", logoutToken({ sub: undefined, sid: undefined })],
  ];
  for (const [why, token] of cases) {
    assert.equal(await verifyLogoutToken(await token, keys, opts), null, why);
  }

  // Unsigned, and HS256 keyed with the public key (algorithm confusion).
  const [header, payload] = (await logoutToken()).split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${payload}.`;
  assert.equal(await verifyLogoutToken(none, keys, opts), null, "alg none");
  const hs = await new SignJWT({
    sub: "alice",
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
  })
    .setProtectedHeader({ alg: "HS256", kid: "realm" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT)
    .setIssuedAt()
    .sign(new TextEncoder().encode(JSON.stringify(publicJwk)));
  assert.equal(await verifyLogoutToken(hs, keys, opts), null, "HS256 confusion");
  assert.equal(await verifyLogoutToken("not.a.jwt", keys, opts), null);
  assert.ok(header);
});
