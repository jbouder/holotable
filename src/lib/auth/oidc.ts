/**
 * Minimal Keycloak OIDC (authorization code) helper.
 *
 * Only what we need: discover endpoints, build the authorize URL, exchange the
 * code for tokens, and trade a refresh token for new ones (#27). The returned id_token is verified via JWKS by
 * lib/auth/session (RS256) and only its validated `sub` + `groups` claims are
 * trusted for authorization (`name` and `email` are read for display); we then
 * mint a first-party session token.
 */

interface Endpoints {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  issuer: string;
}

let cached: Endpoints | null = null;

export async function discover(): Promise<Endpoints> {
  if (cached) return cached;
  const issuer = process.env.OIDC_ISSUER;
  if (!issuer) throw new Error("OIDC_ISSUER is not configured");
  const res = await fetch(
    `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
  );
  if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
  cached = (await res.json()) as Endpoints;
  return cached;
}

export function redirectUri(origin: string): string {
  return process.env.OIDC_REDIRECT_URI || `${origin}/api/auth/callback`;
}

export async function buildAuthorizeUrl(origin: string, state: string, nonce: string) {
  const ep = await discover();
  const params = new URLSearchParams({
    client_id: requireEnv("OIDC_CLIENT_ID"),
    response_type: "code",
    scope: process.env.OIDC_SCOPE || "openid profile email groups",
    redirect_uri: redirectUri(origin),
    state,
    nonce,
  });
  return `${ep.authorization_endpoint}?${params.toString()}`;
}

/**
 * What the token endpoint returns that Holotable reads. `refresh_token` is
 * absent when the client is not allowed refresh tokens; `refresh_expires_in`
 * is Keycloak's (seconds, and 0 for a token with no idle limit) and absent
 * from most other providers.
 */
export interface TokenSet {
  id_token: string;
  refresh_token?: string;
  refresh_expires_in?: number;
}

/**
 * The token endpoint refused the grant (a 400 or 401: `invalid_grant` for a
 * refresh token the realm no longer honours). Distinct from a failure to reach
 * it, because only a refusal means the session is over.
 */
export class OidcGrantRefused extends Error {}

export async function exchangeCode(origin: string, code: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin),
  });
}

/**
 * Trade a refresh token for a fresh token set (#27). The realm re-issues the
 * id_token with the person's CURRENT groups, which is what lets a removed role
 * stop working at the next renewal. It may also rotate the refresh token, so
 * the caller stores whichever one comes back.
 */
export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  return tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    // No `scope`: left out, the realm grants what the sign-in was granted. Sent,
    // anything but an exact subset is `invalid_scope`, and a 400 ends the
    // session.
  });
}

async function tokenRequest(params: Record<string, string>): Promise<TokenSet> {
  const ep = await discover();
  const body = new URLSearchParams({
    ...params,
    client_id: requireEnv("OIDC_CLIENT_ID"),
    client_secret: process.env.OIDC_CLIENT_SECRET || "",
  });
  const res = await fetch(ep.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (res.status === 400 || res.status === 401) {
    throw new OidcGrantRefused(`OIDC ${params.grant_type} refused: ${res.status}`);
  }
  if (!res.ok) throw new Error(`OIDC ${params.grant_type} failed: ${res.status}`);
  return readTokenSet(await res.json());
}

/** A token response is trusted no further than its shape. */
export function readTokenSet(body: unknown): TokenSet {
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<
    string,
    unknown
  >;
  if (typeof raw.id_token !== "string" || raw.id_token === "") {
    throw new Error("OIDC token response carried no id_token");
  }
  const set: TokenSet = { id_token: raw.id_token };
  if (typeof raw.refresh_token === "string" && raw.refresh_token !== "") {
    set.refresh_token = raw.refresh_token;
  }
  if (typeof raw.refresh_expires_in === "number" && raw.refresh_expires_in >= 0) {
    set.refresh_expires_in = raw.refresh_expires_in;
  }
  return set;
}

/** A renewal holds a row lock while it waits, so it must not wait long. */
const TOKEN_TIMEOUT_MS = 10_000;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}
