import { z } from "zod";
import { ShareOrigin } from "@/lib/auth/share";
import type { ShareRecord } from "@/lib/db/shares";
import { type Dashboard, hasQuery, TimeRange, isSqlQuery } from "@/lib/ir";

/** The longest a share link may live, in days (#65). */
export const SHARE_MAX_DAYS = 90;

/** What an editor asks for when they create a share link. */
export const ShareRequest = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    expiresInDays: z.number().int().min(1).max(SHARE_MAX_DAYS),
    allowedOrigins: z.array(ShareOrigin).max(10).optional(),
    /** A window the link always shows, in place of the dashboard's. */
    timeRange: TimeRange.optional(),
  })
  .strict();
export type ShareRequest = z.infer<typeof ShareRequest>;

/** A share as its management list shows it: never the token or its hash. */
export interface ShareView {
  id: string;
  label: string | null;
  allowedOrigins: string[];
  timeRange: TimeRange | null;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

export function shareView(share: ShareRecord): ShareView {
  return {
    id: share.id,
    label: share.label,
    allowedOrigins: share.allowedOrigins,
    timeRange: share.timeRange,
    createdBy: share.createdBy,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    lastUsedAt: share.lastUsedAt,
  };
}

/** Where a share is opened. The token is the only credential in it. */
export function embedPath(dashboardId: string, token: string): string {
  return `/embed/dashboards/${encodeURIComponent(dashboardId)}?token=${encodeURIComponent(token)}`;
}

/**
 * The spec as a share link's page receives it (#65). The browser needs each
 * panel's kind, layout, options and time field to draw it; it does not need
 * the SQL or the source ids, and someone holding a link is not someone who
 * should read either. The stream runs the stored spec on the server, so
 * nothing here is ever executed. Variables are dropped too: a share runs each
 * at its default and offers no picker.
 */
export function sharedSpec(spec: Dashboard, timeRange: TimeRange | null): Dashboard {
  const { variables: _, ...rest } = spec;
  return {
    ...rest,
    ...(timeRange ? { timeRange } : {}),
    panels: spec.panels.map((panel) => {
      if (!hasQuery(panel)) return panel;
      return {
        ...panel,
        // Only what drawing needs: the time field, or whether a PromQL
        // query is an instant one (which decides that it has none).
        query: isSqlQuery(panel.query)
          ? {
              sourceId: "shared",
              sql: "(not shared)",
              ...(panel.query.timeField ? { timeField: panel.query.timeField } : {}),
            }
          : {
              sourceId: "shared",
              promql: "(not shared)",
              ...(panel.query.instant ? { instant: true } : {}),
            },
      };
    }),
  };
}
