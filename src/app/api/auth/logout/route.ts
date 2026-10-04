import { getIdentity, getSessionRef } from "@/lib/auth/authorize";
import { clearSessionCookie, readSessionIdCookie } from "@/lib/auth/cookie";
import { endSession } from "@/lib/auth/renewal";
import { revoke } from "@/lib/auth/revocation";
import { renewalDeps } from "@/lib/auth/session-store";
import { route } from "@/lib/http";
import { audit } from "@/lib/audit";

export const runtime = "nodejs";

export const POST = route("auth.logout", async () => {
  // Read before anything below ends the session. A cookie that no longer
  // verifies names nobody the log can trust, so it signs out unrecorded.
  const identity = await getIdentity();
  // The stored refresh token goes with the session (#27), so nothing on this
  // side can renew it afterwards.
  const sessionId = await readSessionIdCookie();
  if (sessionId) await endSession(renewalDeps, sessionId);
  // And the session token stops verifying now, not at its expiry, should a
  // copy of the cookie outlive this browser's (#28). By realm session only:
  // signing out here must not sign the same person out of their other devices.
  const session = await getSessionRef();
  if (session?.sid) revoke({ sid: session.sid });
  await clearSessionCookie();
  if (identity) {
    audit({ actor: identity, action: "auth.logout", workspaceId: null });
  }
  return Response.json({ ok: true });
});
