import { z } from "zod";
import { ApiTokenRole } from "@/lib/auth/api-token";
import type { ApiTokenRecord } from "@/lib/db/api-tokens";

/** What an admin asks for when they create a token (#288). */
export function apiTokenRequest(maxDays: number) {
  return z
    .object({
      name: z.string().trim().min(1).max(100),
      role: ApiTokenRole,
      expiresInDays: z.number().int().min(1).max(maxDays),
    })
    .strict();
}

/** A token as the management list shows it: never the token or its hash. */
export interface ApiTokenView {
  id: string;
  name: string;
  role: "viewer" | "editor";
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export function apiTokenView(record: ApiTokenRecord): ApiTokenView {
  return {
    id: record.id,
    name: record.name,
    role: record.role,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
  };
}
