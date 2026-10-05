import { HttpError } from "@/lib/auth/authorize";
import { getSourceById } from "@/lib/db/repo";
import { validateSql } from "@/lib/sql/safety";
import { type Dashboard, hasQuery } from "@/lib/ir";
import type { SourceRecord } from "@/lib/registry";

/**
 * Validate a dashboard spec against the source registry and derive its trusted
 * workspace.
 *
 * - Every referenced source must exist and not be tombstoned.
 * - All panels must belong to a single workspace (derived from the trusted
 *   source records, never from a request field).
 * - Every panel's SQL is re-validated against its source catalog here, so the
 *   source is (re)authorized/validated on every save.
 * - A panel that runs no query (a text panel, #202) references no source and
 *   is skipped; a dashboard needs at least one panel that does, because its
 *   sources are what decide its workspace.
 */
export async function resolveAndValidateDashboard(
  spec: Dashboard,
  // Injectable so the rules can be tested without a database, as the poller's
  // executor is.
  getSource: (id: string) => Promise<SourceRecord | null> = getSourceById,
): Promise<{ workspaceId: string; sources: Map<string, SourceRecord> }> {
  const sources = new Map<string, SourceRecord>();
  let workspaceId: string | null = null;

  for (const panel of spec.panels.filter(hasQuery)) {
    const sourceId = panel.query.sourceId;
    let source = sources.get(sourceId);
    if (!source) {
      const found = await getSource(sourceId);
      if (!found) throw new HttpError(400, `unknown source: ${sourceId}`);
      if (found.tombstonedAt) {
        throw new HttpError(400, `source ${sourceId} has been removed (tombstoned)`);
      }
      source = found;
      sources.set(sourceId, source);
    }

    if (workspaceId === null) workspaceId = source.workspaceId;
    else if (workspaceId !== source.workspaceId) {
      throw new HttpError(
        400,
        "all panels in a dashboard must belong to the same workspace",
      );
    }

    const check = await validateSql(panel.query.sql, source.config);
    if (!check.ok) {
      throw new HttpError(400, `panel "${panel.id}": ${check.error}`);
    }
  }

  if (workspaceId === null) {
    throw new HttpError(
      400,
      "a dashboard needs at least one panel with a query; its source decides the dashboard's workspace",
    );
  }
  return { workspaceId, sources };
}
