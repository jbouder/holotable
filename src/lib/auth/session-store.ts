import { query, withTransaction } from "@/lib/db/pg";
import { refreshTokens } from "@/lib/auth/oidc";
import type { RenewalDeps, SessionStore, StoredSession } from "@/lib/auth/renewal";
import { signSessionToken, verifySessionToken } from "@/lib/auth/session";

/**
 * The `sessions` table behind {@link SessionStore} (#27). Every statement is
 * keyed by the SHA-256 of the session id, never the id itself.
 */
export const pgSessionStore: SessionStore = {
  async create(row) {
    await query(
      `INSERT INTO sessions (id_hash, sub, oidc_sid, refresh_token, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.idHash, row.sub, row.oidcSid, row.refreshToken, row.expiresAt],
    );
    // Sweep on the write path, so an abandoned session does not outlive its
    // refresh token in the table. Cheap: `expires_at` is indexed.
    await query(`DELETE FROM sessions WHERE expires_at < now()`);
  },

  async withLocked(idHash, fn) {
    return withTransaction(async (client) => {
      const res = await client.query<{
        sub: string;
        oidc_sid: string | null;
        refresh_token: Buffer;
        expires_at: Date;
      }>(
        `SELECT sub, oidc_sid, refresh_token, expires_at FROM sessions
         WHERE id_hash = $1 FOR UPDATE`,
        [idHash],
      );
      const r = res.rows[0];
      const row: StoredSession | null = r
        ? {
            sub: r.sub,
            oidcSid: r.oidc_sid,
            refreshToken: r.refresh_token,
            expiresAt: new Date(r.expires_at),
          }
        : null;
      return fn({
        row,
        async update(next) {
          await client.query(
            `UPDATE sessions
             SET refresh_token = $2, expires_at = $3, refreshed_at = now()
             WHERE id_hash = $1`,
            [idHash, next.refreshToken, next.expiresAt],
          );
        },
        async remove() {
          await client.query(`DELETE FROM sessions WHERE id_hash = $1`, [idHash]);
        },
      });
    });
  },

  async remove(idHash) {
    await query(`DELETE FROM sessions WHERE id_hash = $1`, [idHash]);
  },
};

/**
 * Back-channel logout (#28): forget the refresh tokens of the realm session it
 * names, or of every session of the subject when it names no session. Returns
 * how many rows went.
 */
export async function removeSessionsFor(target: {
  sub?: string;
  sid?: string;
}): Promise<number> {
  if (target.sid) {
    const rows = await query(`DELETE FROM sessions WHERE oidc_sid = $1 RETURNING 1`, [
      target.sid,
    ]);
    return rows.length;
  }
  if (target.sub) {
    const rows = await query(`DELETE FROM sessions WHERE sub = $1 RETURNING 1`, [
      target.sub,
    ]);
    return rows.length;
  }
  return 0;
}

/** The real database, realm and signer, for the three routes that use them. */
export const renewalDeps: RenewalDeps = {
  store: pgSessionStore,
  refreshTokens,
  verifyIdToken: verifySessionToken,
  signSessionToken,
};
