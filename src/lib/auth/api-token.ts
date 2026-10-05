import { z } from "zod";
import type { Identity } from "@/lib/auth/claims";
import {
  type ApiTokenRecord,
  type ApiTokenStore,
  pgApiTokenStore,
} from "@/lib/db/api-tokens";
import { log } from "@/lib/log";

/**
 * Service-account API tokens (#288): how something that is not a person — a
 * deploy pipeline posting a marker, a script — calls the API.
 *
 * A token is 32 random bytes behind `ht_`, sent as `Authorization: Bearer`.
 * Only its SHA-256 is stored, and every request looks the row up again, so a
 * revoked or expired token is refused on its next use. A token resolves to an
 * identity with one workspace at the token's role, viewer or editor, and
 * nothing else: never source-admin, never platform admin, never a share. So
 * `can()` decides what it may do exactly as it does for a person with that
 * role, with no rule of its own.
 */

export const API_TOKEN_PREFIX = "ht_";

/** The roles a token may hold. Managing sources or tokens is a person's job. */
export const ApiTokenRole = z.enum(["viewer", "editor"]);
export type ApiTokenRole = z.infer<typeof ApiTokenRole>;

const TOKEN_RE = /^ht_[A-Za-z0-9_-]{43}$/;

/** A fresh token: shown once, then only its hash exists. */
export function generateApiToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${API_TOKEN_PREFIX}${Buffer.from(bytes).toString("base64url")}`;
}

export async function apiTokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Buffer.from(digest).toString("hex");
}

/** The token in an `Authorization: Bearer ht_…` header, or null for any other header. */
export function bearerApiToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const token = match?.[1];
  return token && TOKEN_RE.test(token) ? token : null;
}

/** The identity a token row stands for. */
export function apiTokenIdentity(record: ApiTokenRecord): Identity {
  const role = ApiTokenRole.parse(record.role);
  return {
    sub: `token:${record.id}`,
    platformAdmin: false,
    workspaces: { [record.workspaceId]: role },
    serviceAccount: { tokenId: record.id, name: record.name },
  };
}

/**
 * The identity a bearer token resolves to, or null: unknown, revoked or
 * expired. A row whose role is somehow not viewer or editor resolves to
 * nothing rather than to whatever it says.
 */
export async function resolveApiToken(
  token: string,
  store: ApiTokenStore = pgApiTokenStore,
  now: number = Date.now(),
): Promise<Identity | null> {
  if (!TOKEN_RE.test(token)) return null;
  const record = await store.byHash(await apiTokenHash(token));
  if (!record || record.revokedAt !== null) return null;
  if (Date.parse(record.expiresAt) <= now) return null;
  if (!ApiTokenRole.safeParse(record.role).success) return null;
  store.touch(record.id).catch((err) => log.warn("api_token.touch_failed", { err }));
  return apiTokenIdentity(record);
}
