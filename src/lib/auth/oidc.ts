/**
 * Minimal Keycloak OIDC (authorization code) helper.
 *
 * Only what we need: discover endpoints, build the authorize URL, and exchange
 * the code for tokens. The returned id_token is verified via JWKS by
 * lib/auth/session (RS256) and only its validated `sub` + `groups` claims are
 * trusted; we then mint a first-party session token.
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
  const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
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
    scope: process.env.OIDC_SCOPE || "openid profile groups",
    redirect_uri: redirectUri(origin),
    state,
    nonce,
  });
  return `${ep.authorization_endpoint}?${params.toString()}`;
}

export async function exchangeCode(origin: string, code: string): Promise<{ id_token: string }> {
  const ep = await discover();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(origin),
    client_id: requireEnv("OIDC_CLIENT_ID"),
    client_secret: process.env.OIDC_CLIENT_SECRET || "",
  });
  const res = await fetch(ep.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`OIDC token exchange failed: ${res.status}`);
  return (await res.json()) as { id_token: string };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}
