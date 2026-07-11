import { cookies } from "next/headers";
import { config } from "@/lib/config";

/** Set the session cookie (httpOnly, secure in production, SameSite=Lax). */
export async function setSessionCookie(token: string, maxAgeSeconds = 60 * 60 * 8) {
  const store = await cookies();
  store.set(config.sessionCookieName, token, {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: maxAgeSeconds,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(config.sessionCookieName);
}
