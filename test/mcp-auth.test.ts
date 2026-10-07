import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createLocalJWKSet, exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { apiTokenHash, generateApiToken } from "@/lib/auth/api-token";
import { can } from "@/lib/auth/authorize";
import {
  authenticateMcp,
  MCP_PATH,
  type McpAuthDeps,
  mcpChallenge,
  mcpOrigin,
  PROTECTED_RESOURCE_PATH,
  protectedResourceMetadata,
  verifyMcpToken,
} from "@/lib/auth/mcp-token";
import { resetRevocations, revoke } from "@/lib/auth/revocation";
import { verifySessionToken } from "@/lib/auth/session";
import type { ApiTokenRecord, ApiTokenStore } from "@/lib/db/api-tokens";

/**
 * Authentication for MCP clients (#149): a realm access token minted for the
 * MCP client is accepted at `/api/mcp`, and nothing else is, anywhere.
 */

const ISSUER = "http://localhost:8080/realms/holotable";
const WEB_CLIENT = "holotable";
const MCP_CLIENT = "holotable-mcp";

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
const opts = { issuer: ISSUER, clientId: MCP_CLIENT };

/** An access token as Keycloak mints one for the MCP client. */
async function accessToken(
  claims: Record<string, unknown> = {},
  sign: {
    key?: CryptoKey;
    issuer?: string;
    audience?: string | string[];
    exp?: string;
  } = {},
) {
  const { realm } = await fixture;
  return new SignJWT({
    typ: "Bearer",
    azp: MCP_CLIENT,
    sid: "kc-1",
    groups: ["/workspaces/ops/editor"],
    name: "Alice",
    email: "alice@example.com",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "realm", typ: "JWT" })
    .setSubject(typeof claims.sub === "string" ? claims.sub : "alice")
    .setIssuer(sign.issuer ?? ISSUER)
    .setAudience(sign.audience ?? MCP_CLIENT)
    .setIssuedAt()
    .setExpirationTime(sign.exp ?? "5m")
    .sign(sign.key ?? realm.privateKey);
}

afterEach(() => resetRevocations());

test("an access token the realm minted for the MCP client verifies", async () => {
  const { keys } = await fixture;
  const payload = await verifyMcpToken(await accessToken(), keys, opts);
  assert.equal(payload?.sub, "alice");
  assert.equal(payload?.azp, MCP_CLIENT);
});

test("anything else the realm's keys could have signed is refused", async () => {
  const { keys, stranger } = await fixture;
  const cases: [string, Promise<string>][] = [
    ["signed by another key", accessToken({}, { key: stranger.privateKey })],
    ["expired", accessToken({}, { exp: "-1m" })],
    ["another issuer", accessToken({}, { issuer: "http://localhost:8080/realms/other" })],
    ["the browser client's audience", accessToken({}, { audience: WEB_CLIENT })],
    ["Keycloak's default audience only", accessToken({}, { audience: "account" })],
    [
      "addressed to us but minted for another client",
      accessToken({ azp: WEB_CLIENT }, { audience: [MCP_CLIENT, "account"] }),
    ],
    ["an id_token (typ ID)", accessToken({ typ: "ID" })],
    ["an id_token (carries the nonce)", accessToken({ nonce: "n-1" })],
    ["no typ at all", accessToken({ typ: undefined })],
    ["no subject", accessToken({ sub: "" })],
  ];
  for (const [name, token] of cases) {
    assert.equal(await verifyMcpToken(await token, keys, opts), null, name);
  }
  assert.equal(await verifyMcpToken("not.a.jwt", keys, opts), null);
});

test("a token signed with the session secret is not a realm token", async () => {
  const { keys } = await fixture;
  const session = await new SignJWT({ typ: "Bearer", azp: MCP_CLIENT })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("alice")
    .setIssuer(ISSUER)
    .setAudience(MCP_CLIENT)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode("dev-insecure-session-secret".padEnd(32, "0")));
  assert.equal(await verifyMcpToken(session, keys, opts), null);
});

/* -------------------------------------------------------------------------- */
/* The header, and the identity it resolves to                                */
/* -------------------------------------------------------------------------- */

function record(extra: Partial<ApiTokenRecord> = {}): ApiTokenRecord {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    workspaceId: "ops",
    name: "deploy pipeline",
    tokenHash: "",
    role: "viewer",
    createdBy: "u1",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    revokedAt: null,
    lastUsedAt: null,
    ...extra,
  };
}

function memoryStore(rows: ApiTokenRecord[]): ApiTokenStore {
  return {
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
    async touch() {},
  };
}

async function deps(extra: Partial<McpAuthDeps> = {}): Promise<McpAuthDeps> {
  const { keys } = await fixture;
  return {
    keys,
    issuer: ISSUER,
    clientId: MCP_CLIENT,
    apiTokens: memoryStore([]),
    ...extra,
  };
}

test("a realm token in the bearer header is the person, with their groups, for can()", async () => {
  const result = await authenticateMcp(`Bearer ${await accessToken()}`, await deps());
  assert.ok(result.ok);
  const { identity } = result;
  assert.equal(identity.sub, "alice");
  assert.deepEqual(identity.workspaces, { ops: "editor" });
  assert.equal(identity.platformAdmin, false);
  assert.equal(identity.displayName, "Alice");
  assert.equal(identity.email, "alice@example.com");
  assert.equal(identity.serviceAccount, undefined);
  assert.equal(can(identity, "dashboard:update", { workspaceId: "ops" }), true);
  assert.equal(can(identity, "source:manage", { workspaceId: "ops" }), false);
  assert.equal(can(identity, "dashboard:view", { workspaceId: "other" }), false);
});

test("a revoked realm session is refused on its next MCP request", async () => {
  const token = await accessToken({ sid: "kc-9" });
  assert.equal((await authenticateMcp(`Bearer ${token}`, await deps())).ok, true);
  revoke({ sid: "kc-9" });
  assert.deepEqual(await authenticateMcp(`Bearer ${token}`, await deps()), {
    ok: false,
    reason: "invalid",
  });
});

test("a service-account token is accepted by its prefix and resolves as it does elsewhere", async () => {
  const token = generateApiToken();
  const store = memoryStore([record({ tokenHash: await apiTokenHash(token) })]);
  const result = await authenticateMcp(
    `Bearer ${token}`,
    await deps({ apiTokens: store }),
  );
  assert.ok(result.ok);
  assert.equal(result.identity.sub, "token:44444444-4444-4444-8444-444444444444");
  assert.deepEqual(result.identity.workspaces, { ops: "viewer" });

  const revoked = memoryStore([
    record({ tokenHash: await apiTokenHash(token), revokedAt: new Date().toISOString() }),
  ]);
  assert.deepEqual(
    await authenticateMcp(`Bearer ${token}`, await deps({ apiTokens: revoked })),
    { ok: false, reason: "invalid" },
  );
  // Never looked up against the realm, whatever it looks like.
  assert.deepEqual(
    await authenticateMcp(
      `Bearer ${token}`,
      await deps({ apiTokens: store, keys: null }),
    ),
    { ok: true, identity: result.identity },
  );
});

test("no header is 'missing', a refused one is 'invalid', and neither falls back", async () => {
  for (const header of [null, "", "Basic abc"]) {
    assert.deepEqual(await authenticateMcp(header, await deps()), {
      ok: false,
      reason: "missing",
    });
  }
  const token = await accessToken();
  for (const header of [
    "Bearer",
    "Bearer  ",
    `Bearer ${token}x`,
    `Bearer ${token} extra`,
    "Bearer ht_short",
  ]) {
    assert.deepEqual(await authenticateMcp(header, await deps()), {
      ok: false,
      reason: "invalid",
    });
  }
  // Not configured: a realm token has nothing to be checked against.
  for (const partial of [
    { keys: null },
    { issuer: undefined },
    { clientId: undefined },
  ]) {
    assert.deepEqual(await authenticateMcp(`Bearer ${token}`, await deps(partial)), {
      ok: false,
      reason: "invalid",
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Only /api/mcp                                                              */
/* -------------------------------------------------------------------------- */

test("a token minted for the MCP client is never a session", async () => {
  // The session verifier's realm branch needs `OIDC_JWKS_URL`; without it, the
  // only thing that could accept a realm token is the branch under test, so
  // its absence makes the assertion vacuous rather than a pass. Point it at
  // the fixture's keys through the module's own loader instead.
  const { publicJwk } = await fixture;
  const previous = {
    jwks: process.env.OIDC_JWKS_URL,
    issuer: process.env.OIDC_ISSUER,
    mcp: process.env.OIDC_MCP_CLIENT_ID,
  };
  const originalFetch = globalThis.fetch;
  process.env.OIDC_JWKS_URL = "http://realm.test/certs";
  process.env.OIDC_ISSUER = ISSUER;
  process.env.OIDC_MCP_CLIENT_ID = MCP_CLIENT;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    assert.equal(url, "http://realm.test/certs");
    return Response.json({ keys: [publicJwk] });
  }) as typeof fetch;
  try {
    // Verified by the realm's keys, addressed to this app, and still refused:
    // it was minted for the MCP client.
    const token = await accessToken({}, { audience: [WEB_CLIENT, MCP_CLIENT] });
    assert.equal(await verifySessionToken(token), null);
    // The same token minted for the browser client is what the realm branch
    // is for, so the refusal above is the `azp` check and not something else.
    const web = await accessToken(
      { azp: WEB_CLIENT },
      { audience: [WEB_CLIENT, MCP_CLIENT] },
    );
    assert.equal((await verifySessionToken(web))?.sub, "alice");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.OIDC_JWKS_URL = previous.jwks;
    process.env.OIDC_ISSUER = previous.issuer;
    process.env.OIDC_MCP_CLIENT_ID = previous.mcp;
  }
});

test("only the MCP route and its metadata read a bearer realm token", () => {
  const root = new URL("../src/app", import.meta.url).pathname;
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (
        /\.(ts|tsx)$/.test(entry) &&
        readFileSync(path, "utf8").includes("@/lib/auth/mcp-token")
      ) {
        found.push(path.slice(root.length));
      }
    }
  };
  walk(root);
  assert.deepEqual(found.sort(), [
    "/.well-known/oauth-protected-resource/[[...resource]]/route.ts",
    "/api/mcp/route.ts",
  ]);
  // `getIdentity()` — every other route's authentication — knows nothing of it.
  const authorize = readFileSync(
    new URL("../src/lib/auth/authorize.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/mcp/i.test(authorize), false);
  // And the MCP route reads no cookie.
  const mcpRoute = readFileSync(
    new URL("../src/app/api/mcp/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal(/cookies|getIdentity|requireIdentity/.test(mcpRoute), false);
});

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

test("the challenge names the metadata for the MCP resource, and says when a token was refused", () => {
  const missing = mcpChallenge("https://holotable.example.com", "missing");
  assert.equal(missing.status, 401);
  assert.equal(
    missing.headers["WWW-Authenticate"],
    'Bearer resource_metadata="https://holotable.example.com/.well-known/oauth-protected-resource/api/mcp"',
  );
  const invalid = mcpChallenge("https://holotable.example.com", "invalid");
  assert.equal(
    invalid.headers["WWW-Authenticate"],
    'Bearer error="invalid_token", resource_metadata="https://holotable.example.com/.well-known/oauth-protected-resource/api/mcp"',
  );
  assert.equal(invalid.headers["Cache-Control"], "no-store");
});

test("the metadata names this origin's MCP endpoint and the realm", () => {
  assert.deepEqual(protectedResourceMetadata("https://holotable.example.com", ISSUER), {
    resource: "https://holotable.example.com/api/mcp",
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
    resource_name: "Holotable",
  });
  assert.equal(
    `${PROTECTED_RESOURCE_PATH}${MCP_PATH}`,
    "/.well-known/oauth-protected-resource/api/mcp",
  );
});

test("the origin is the one the client addressed, behind a proxy too", () => {
  const direct = new Request("http://localhost:3000/api/mcp");
  assert.equal(mcpOrigin(direct), "http://localhost:3000");
  const proxied = new Request("http://10.0.0.5:3000/api/mcp", {
    headers: {
      host: "holotable.example.com",
      "x-forwarded-host": "holotable.example.com",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(mcpOrigin(proxied), "https://holotable.example.com");
});
