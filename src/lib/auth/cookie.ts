import { cookies } from "next/headers";
import { config } from "@/lib/config";

/**
 * Set the session cookie (httpOnly, secure in production, SameSite=Lax). When
 * `Secure`, its name carries `__Host-` (#26), which the browser honors only on
 * a cookie with `Path=/` and no `Domain` — so neither may ever be added here.
 */
export async function setSessionCookie(token: string, maxAgeSeconds = 60 * 60 * 8) {
  const store = await cookies();
  store.set(config.sessionCookieName, token, {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

/**
 * The renewal cookie (#27): the opaque id of a `sessions` row, and nothing
 * else. Scoped to `/api/auth`, so it travels only with sign-in, renewal and
 * sign-out — never with a page, an API call or a stream. It outlives the
 * session cookie on purpose: a tab that slept past its token can still renew.
 */
export const SESSION_ID_PATH = "/api/auth";

export function sessionIdCookieName(): string {
  // `__Secure-`, not `__Host-`, when Secure: `__Host-` requires `Path=/` (#26).
  return config.renewCookieName;
}

export async function setSessionIdCookie(sessionId: string, maxAgeSeconds: number) {
  const store = await cookies();
  store.set(sessionIdCookieName(), sessionId, {
    httpOnly: true,
    secure: config.sessionCookieSecure,
    sameSite: "lax",
    path: SESSION_ID_PATH,
    maxAge: maxAgeSeconds,
  });
}

export async function readSessionIdCookie(): Promise<string | undefined> {
  return (await cookies()).get(sessionIdCookieName())?.value;
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(config.sessionCookieName);
  // A cookie is deleted by the path it was set with.
  store.delete({ name: sessionIdCookieName(), path: SESSION_ID_PATH });
}
