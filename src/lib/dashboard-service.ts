import { serverKind } from "@/lib/sources/server/registry";
import { HttpError } from "@/lib/auth/authorize";
import { getSourceById } from "@/lib/db/repo";
import { type Dashboard, declaredVariables, hasQuery } from "@/lib/ir";
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
 * - A panel's `:name` references must be variables the dashboard declares
 *   (#67), and a `query` variable's SELECT is held to the same rules as a
 *   panel's: its source exists, is in the dashboard's workspace, and the
 *   statement passes the guard, with no variables of its own.
 */
export async function resolveAndValidateDashboard(
  spec: Dashboard,
  // Injectable so the rules can be tested without a database, as the poller's
  // executor is.
  getSource: (id: string) => Promise<SourceRecord | null> = getSourceById,
): Promise<{ workspaceId: string; sources: Map<string, SourceRecord> }> {
  const sources = new Map<string, SourceRecord>();
  let workspaceId: string | null = null;
  const declared = declaredVariables(spec);

  const sourceOf = async (sourceId: string): Promise<SourceRecord> => {
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
    return source;
  };

  for (const panel of spec.panels.filter(hasQuery)) {
    const source = await sourceOf(panel.query.sourceId);

    if (workspaceId === null) workspaceId = source.workspaceId;
    else if (workspaceId !== source.workspaceId) {
      throw new HttpError(
        400,
        "all panels in a dashboard must belong to the same workspace",
      );
    }

    // The source's kind holds the query to its own language first: a query
    // in another is refused like a table the source does not have.
    const check = await serverKind(source).check(source, panel.query, declared);
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

  for (const variable of spec.variables ?? []) {
    if (!variable.query) continue;
    const source = await sourceOf(variable.query.sourceId);
    if (source.workspaceId !== workspaceId) {
      throw new HttpError(
        400,
        `variable "${variable.name}" reads a source outside the dashboard's workspace`,
      );
    }
    const check = await serverKind(source).checkVariable(source, variable.query);
    if (!check.ok) {
      throw new HttpError(400, `variable "${variable.name}": ${check.error}`);
    }
  }
  return { workspaceId, sources };
}
