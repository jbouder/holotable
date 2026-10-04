import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { authorizeParams, exchangeCode, type TokenSet } from "@/lib/auth/oidc";
import {
  codeChallenge,
  completeSignIn,
  type Handshake,
  newHandshake,
  sameValue,
  SignInRefused,
  type SignInRefusal,
} from "@/lib/auth/sign-in";

/*
 * #281: a sign-in is bound to the browser that started it, by the id_token's
 * nonce and by PKCE.
 */

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
  return { realm, stranger, keys: createLocalJWKSet({ keys: [publicJwk] }) };
})();

async function idToken(claims: Record<string, unknown>, key?: CryptoKey) {
  const { realm } = await fixture;
  return new SignJWT({ sub: "alice", groups: ["/workspaces/acme/viewer"], ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "realm" })
    .setIssuer(ISSUER)
    .setAudience(CLIENT)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(key ?? realm.privateKey);
}

const HANDSHAKE: Handshake = { state: "s-1", nonce: "n-1", verifier: "v".repeat(43) };

/** A realm whose token endpoint answers with `token`, recording each exchange. */
async function realmReturning(token: string | Promise<string>) {
  const { keys } = await fixture;
  const exchanges: { code: string; verifier: string }[] = [];
  const deps = {
    keys,
    issuer: ISSUER,
    audience: CLIENT,
    exchange: async (code: string, verifier: string): Promise<TokenSet> => {
      exchanges.push({ code, verifier });
      return { id_token: await token };
    },
  };
  return { deps, exchanges };
}

async function refusal(promise: Promise<unknown>): Promise<SignInRefusal> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof SignInRefused, `expected a refusal, got ${err}`);
    return err.reason;
  }
  assert.fail("the sign-in was not refused");
}

const params = { code: "code-1", state: "s-1" };

test("the browser that started the sign-in completes it", async () => {
  const { deps, exchanges } = await realmReturning(idToken({ nonce: "n-1" }));
  const { claims, tokens } = await completeSignIn(params, HANDSHAKE, deps);
  assert.equal(claims.sub, "alice");
  assert.equal(typeof tokens.id_token, "string");
  assert.deepEqual(exchanges, [{ code: "code-1", verifier: HANDSHAKE.verifier }]);
});

test("an id_token carrying someone else's nonce is refused", async () => {
  // The injection: the attacker's own state and cookies, the victim's code.
  const { deps } = await realmReturning(idToken({ nonce: "victims-nonce" }));
  assert.equal(await refusal(completeSignIn(params, HANDSHAKE, deps)), "nonce");
});

test("an id_token with no nonce, or a nonce that is not a string, is refused", async () => {
  for (const claims of [{}, { nonce: 7 }, { nonce: ["n-1"] }]) {
    const { deps } = await realmReturning(idToken(claims));
    assert.equal(await refusal(completeSignIn(params, HANDSHAKE, deps)), "nonce");
  }
});

test("a missing nonce or verifier cookie is refused before the code goes anywhere", async () => {
  for (const missing of ["nonce", "verifier"] as const) {
    const { deps, exchanges } = await realmReturning(idToken({ nonce: "n-1" }));
    const { [missing]: _gone, ...rest } = HANDSHAKE;
    assert.equal(await refusal(completeSignIn(params, rest, deps)), "handshake");
    assert.equal(exchanges.length, 0);
  }
});

test("a state that is missing or not this browser's is refused first", async () => {
  const { deps, exchanges } = await realmReturning(idToken({ nonce: "n-1" }));
  for (const [p, h] of [
    [{ code: "code-1", state: "s-2" }, HANDSHAKE],
    [{ code: "code-1", state: null }, HANDSHAKE],
    [{ code: null, state: "s-1" }, HANDSHAKE],
    [params, { ...HANDSHAKE, state: undefined }],
  ] as const) {
    assert.equal(await refusal(completeSignIn(p, h, deps)), "state");
  }
  assert.equal(exchanges.length, 0);
});

test("an id_token not signed by the realm is refused, never read as a session", async () => {
  const { stranger } = await fixture;
  const { deps } = await realmReturning(idToken({ nonce: "n-1" }, stranger.privateKey));
  assert.equal(await refusal(completeSignIn(params, HANDSHAKE, deps)), "id_token");

  const { deps: noKeys } = await realmReturning(idToken({ nonce: "n-1" }));
  assert.equal(
    await refusal(completeSignIn(params, HANDSHAKE, { ...noKeys, keys: null })),
    "id_token",
    "without the realm's keys nothing verifies",
  );
});

test("the id_token must be for this client from this realm", async () => {
  const { deps } = await realmReturning(idToken({ nonce: "n-1" }));
  assert.equal(
    await refusal(
      completeSignIn(params, HANDSHAKE, { ...deps, issuer: "https://other" }),
    ),
    "id_token",
  );
  assert.equal(
    await refusal(
      completeSignIn(params, HANDSHAKE, { ...deps, audience: "other-client" }),
    ),
    "id_token",
  );
});

/* -------------------------------------------------------------------------- */
/* PKCE                                                                       */
/* -------------------------------------------------------------------------- */

test("the S256 challenge matches RFC 7636's worked example", () => {
  assert.equal(
    codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("each sign-in gets fresh values a verifier can be made of", () => {
  const a = newHandshake();
  const b = newHandshake();
  assert.notEqual(a.state, b.state);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.verifier, b.verifier);
  // RFC 7636 §4.1: 43 to 128 unreserved characters.
  assert.match(a.verifier, /^[A-Za-z0-9\-._~]{43,128}$/);
});

test("the authorize request carries the nonce and the challenge, never the verifier", () => {
  process.env.OIDC_CLIENT_ID = CLIENT;
  const query = authorizeParams("http://localhost:3000", HANDSHAKE);
  assert.equal(query.get("state"), "s-1");
  assert.equal(query.get("nonce"), "n-1");
  assert.equal(query.get("code_challenge"), codeChallenge(HANDSHAKE.verifier));
  assert.equal(query.get("code_challenge_method"), "S256");
  assert.ok(!query.toString().includes(HANDSHAKE.verifier));
});

test("the code exchange sends the verifier", async () => {
  process.env.OIDC_ISSUER = "http://realm.test/realms/holotable";
  process.env.OIDC_CLIENT_ID = CLIENT;
  const sent: URLSearchParams[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/.well-known/openid-configuration")) {
      return Response.json({
        authorization_endpoint: "http://realm.test/auth",
        token_endpoint: "http://realm.test/token",
        jwks_uri: "http://realm.test/certs",
        issuer: process.env.OIDC_ISSUER,
      });
    }
    sent.push(new URLSearchParams(String(init?.body)));
    return Response.json({ id_token: "t" });
  }) as typeof fetch;
  try {
    await exchangeCode("http://localhost:3000", "code-1", HANDSHAKE.verifier);
  } finally {
    globalThis.fetch = original;
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].get("grant_type"), "authorization_code");
  assert.equal(sent[0].get("code"), "code-1");
  assert.equal(sent[0].get("code_verifier"), HANDSHAKE.verifier);
});

test("sameValue compares whole strings", () => {
  assert.equal(sameValue("abc", "abc"), true);
  assert.equal(sameValue("abc", "abd"), false);
  assert.equal(sameValue("abc", "abcd"), false);
  assert.equal(sameValue("", ""), true);
});

test("the callback deletes every handshake cookie before it checks anything", () => {
  // The route cannot run outside a Next request, so this reads it: each value
  // must be single-use, on a refusal as much as on success.
  const source = readFileSync(
    join(process.cwd(), "src/app/api/auth/callback/route.ts"),
    "utf8",
  );
  const checked = source.indexOf("completeSignIn(");
  for (const name of [
    "oidcStateCookieName",
    "oidcNonceCookieName",
    "oidcVerifierCookieName",
  ]) {
    const deleted = source.indexOf(`store.delete(config.${name})`);
    assert.ok(deleted !== -1, `${name} is never deleted`);
    assert.ok(deleted < checked, `${name} is deleted only after the checks`);
  }
});
