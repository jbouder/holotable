import { clearSessionCookie, readSessionIdCookie } from "@/lib/auth/cookie";
import { endSession } from "@/lib/auth/renewal";
import { renewalDeps } from "@/lib/auth/session-store";
import { route } from "@/lib/http";

export const runtime = "nodejs";

export const POST = route("auth.logout", async () => {
  // The stored refresh token goes with the session (#27), so nothing on this
  // side can renew it afterwards.
  const sessionId = await readSessionIdCookie();
  if (sessionId) await endSession(renewalDeps, sessionId);
  await clearSessionCookie();
  return Response.json({ ok: true });
});
