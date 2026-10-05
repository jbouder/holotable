import type { Identity } from "@/lib/auth/claims";
import {
  type ShareClaims,
  shareIdentity,
  shareTokenHash,
  verifyShareToken,
} from "@/lib/auth/share";
import { pgShareStore, type ShareRecord, type ShareStore } from "@/lib/db/shares";
import { log } from "@/lib/log";

/**
 * A share token checked against its row (#65): signed by this server, not
 * expired, the very token the row was minted with, not revoked, and for the
 * dashboard the caller is asking about. Anything else is null, and the
 * caller answers as for a dashboard that does not exist.
 */
export async function resolveShare(
  token: unknown,
  dashboardId: string,
  store: ShareStore = pgShareStore,
  now: number = Date.now(),
): Promise<{ identity: Identity; claims: ShareClaims; share: ShareRecord } | null> {
  const claims = await verifyShareToken(token, now);
  if (!claims || claims.did !== dashboardId) return null;
  const share = await store.get(claims.sid);
  if (!share) return null;
  if (share.revokedAt !== null) return null;
  if (Date.parse(share.expiresAt) <= now) return null;
  if (share.dashboardId !== dashboardId) return null;
  if (share.tokenHash !== (await shareTokenHash(token as string))) return null;
  store.touch(share.id).catch((err) => log.warn("share.touch_failed", { err }));
  return {
    identity: shareIdentity({
      shareId: share.id,
      dashboardId: share.dashboardId,
      workspaceId: share.workspaceId,
    }),
    claims,
    share,
  };
}
