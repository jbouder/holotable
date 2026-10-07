import { type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";
import { API_TOKEN_PREFIX, resolveApiToken } from "@/lib/auth/api-token";
import { HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { publicOrigin } from "@/lib/auth/origin";
import { identityFromPayload, realmJwks } from "@/lib/auth/session";
import { config } from "@/lib/config";
import type { ApiTokenStore } from "@/lib/db/api-tokens";

/**
 * How an MCP client authenticates (#149).
 *
 * An MCP client (Claude Code, Claude Desktop) runs outside the browser and
 * cannot hold the session cookie, so `/api/mcp` is the one route that accepts
 * a token the realm issued, and it accepts it only in an `Authorization:
 * Bearer` header. The client finds the realm by itself: an unauthenticated
 * call is answered 401 with `WWW-Authenticate` naming this server's
 * protected-resource metadata (RFC 9728), which names the realm as the
 * authorization server; the client then runs the authorization-code flow
 * with PKCE in a browser against a second, public realm client,
 * `OIDC_MCP_CLIENT_ID`, and sends the access token it was given.
 *
 * The token is verified against the realm's keys with the issuer and the
 * audience, and it must have been minted for the MCP client (`azp`) as an
 * access token (`typ: Bearer`, no `nonce`): an id_token, or a token the
 * realm issued to any other client, is refused. The identity is then what
 * {@link identityFromPayload} makes of the claims — the same groups parser
 * and the same revocation check as a session, so a back-channel logout ends
 * an MCP session on its next request too. Authorization is `can()`'s alone.
 *
 * A service-account token (`ht_…`, #288) is accepted here as well, by its
 * prefix, resolving exactly as it does on the HTTP routes.
 *
 * The session cookie is not read, and `getIdentity()` never reaches this
 * module: a realm token is a credential for `/api/mcp` and nothing else
 * (`verifySessionToken` refuses one minted for the MCP client outright).
 * `test/mcp-auth.test.ts` holds the list of routes that call it.
 */

/** The MCP endpoint, which is the protected resource. */
export const MCP_PATH = "/api/mcp";

/**
 * Where the protected-resource metadata is served. RFC 9728 §3 puts the
 * metadata for a resource with a path under the well-known prefix followed by
 * that path, and the 401 challenge names that URL exactly; the bare prefix
 * answers the same document for a client that only looks there.
 */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";

export interface McpTokenOptions {
  issuer: string;
  /** The MCP client's id: the token's audience and its authorized party. */
  clientId: string;
}

/**
 * The verified claims of an access token the realm minted for the MCP
 * client, or null for anything else. Signature (the realm's keys only),
 * issuer, audience and expiry are `jwtVerify`'s; the rest tells an MCP
 * access token from every other token the same keys sign.
 */
export async function verifyMcpToken(
  token: string,
  keys: JWTVerifyGetKey,
  opts: McpTokenOptions,
): Promise<JWTPayload | null> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keys, {
      issuer: opts.issuer,
      audience: opts.clientId,
      requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch {
    return null;
  }
  // Minted for the MCP client, not merely addressed to it: another client's
  // token can carry our id in `aud` if the realm is configured to, and the
  // browser client's never says `azp` is us.
  if (typeof payload.sub !== "string" || payload.sub === "") return null;
  if (payload.azp !== opts.clientId) return null;
  // An access token, as Keycloak types it. An id_token says `ID` and carries
  // the sign-in's nonce; neither is a credential.
  if ((payload as Record<string, unknown>).typ !== "Bearer") return null;
  if ("nonce" in payload) return null;
  return payload;
}

/** `missing`: no bearer header at all. `invalid`: one that did not verify. */
export type McpRefusal = "missing" | "invalid";

export type McpAuthResult =
  | { ok: true; identity: Identity }
  | { ok: false; reason: McpRefusal };

export interface McpAuthDeps {
  /** The realm's signing keys, or null when `OIDC_JWKS_URL` is not set. */
  keys: JWTVerifyGetKey | null;
  issuer: string | undefined;
  clientId: string | undefined;
  /** Where `ht_` tokens are looked up; the database unless a test says otherwise. */
  apiTokens?: ApiTokenStore;
}

/** The deps as the environment configures them. */
export function mcpAuthDeps(): McpAuthDeps {
  return {
    keys: realmJwks(),
    issuer: process.env.OIDC_ISSUER,
    clientId: config.oidcMcpClientId || undefined,
  };
}

/**
 * Whether `/api/mcp` is open at all: never in demo mode, which has no realm,
 * and not until the MCP client and the realm are configured.
 */
export function mcpEnabled(deps: McpAuthDeps = mcpAuthDeps()): boolean {
  return config.authMode !== "demo" && Boolean(deps.keys && deps.issuer && deps.clientId);
}

/**
 * The identity an `Authorization` header carries into `/api/mcp`, or why it
 * carries none. One credential, one identity: a header that does not verify
 * is a refusal, never a reason to look anywhere else.
 */
export async function authenticateMcp(
  header: string | null,
  deps: McpAuthDeps,
): Promise<McpAuthResult> {
  if (!header || !/^bearer\b/i.test(header.trim()))
    return { ok: false, reason: "missing" };
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return { ok: false, reason: "invalid" };
  const token = match[1];

  if (token.startsWith(API_TOKEN_PREFIX)) {
    const identity = await resolveApiToken(token, deps.apiTokens);
    return identity ? { ok: true, identity } : { ok: false, reason: "invalid" };
  }

  if (!deps.keys || !deps.issuer || !deps.clientId)
    return { ok: false, reason: "invalid" };
  const payload = await verifyMcpToken(token, deps.keys, {
    issuer: deps.issuer,
    clientId: deps.clientId,
  });
  const identity = payload ? identityFromPayload(payload) : null;
  return identity ? { ok: true, identity } : { ok: false, reason: "invalid" };
}

/**
 * The origin this server is reached at, for the URLs the metadata and the
 * challenge name. Behind a reverse proxy the bind address is wrong, so the
 * forwarded headers decide, as they do for the sign-in redirect.
 */
export function mcpOrigin(req: Request): string {
  return publicOrigin(req.headers, new URL(req.url));
}

/**
 * The 401 that starts a client's sign-in (RFC 9728 §5.1, RFC 6750 §3):
 * `WWW-Authenticate: Bearer` naming the metadata URL, and `invalid_token`
 * when a token was presented and refused, so a client with a stale token
 * knows to sign in again rather than retry.
 */
export function mcpChallenge(origin: string, reason: McpRefusal): HttpError {
  const params = [
    ...(reason === "invalid" ? ['error="invalid_token"'] : []),
    `resource_metadata="${origin}${PROTECTED_RESOURCE_PATH}${MCP_PATH}"`,
  ];
  return new HttpError(401, "authentication required", {
    "WWW-Authenticate": `Bearer ${params.join(", ")}`,
    "Cache-Control": "no-store",
  });
}

/**
 * The protected-resource metadata (RFC 9728 §2): which resource this is and
 * which authorization server issues tokens for it. The realm's own metadata
 * (`<issuer>/.well-known/openid-configuration`) says the rest.
 */
export function protectedResourceMetadata(origin: string, issuer: string) {
  return {
    resource: `${origin}${MCP_PATH}`,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email"],
    resource_name: "Holotable",
  };
}
