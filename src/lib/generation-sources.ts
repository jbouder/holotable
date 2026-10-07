import { z } from "zod";
import { assertAuthorized, HttpError } from "@/lib/auth/authorize";
import type { Identity } from "@/lib/auth/claims";
import { catalogHealth, catalogRefusal } from "@/lib/catalog/health";
import type { SourceRecord } from "@/lib/registry";
import { MAX_ADDITIONAL_SOURCES } from "@/lib/source-selection";

/**
 * Which sources one generation may use (#104).
 *
 * A dashboard generation names a primary `sourceId` and up to two more; a
 * panel edit or an explore question names only the one. Every source is
 * looked up from the registry and held to the same three checks as the
 * primary always was: it exists and is live, the caller may generate in its
 * workspace (taken from the source record, never from the request), and its
 * catalog can produce working SQL. On top of that, every source must be in
 * the primary's workspace, because a dashboard belongs to exactly one.
 *
 * Nothing is dropped quietly: a source that fails any check refuses the
 * whole request, so the author never gets a dashboard over fewer sources
 * than they picked without being told.
 */

export const AdditionalSourceIds = z
  .array(z.string().min(1).max(128))
  .max(MAX_ADDITIONAL_SOURCES, `at most ${MAX_ADDITIONAL_SOURCES} additional sources`);

export async function resolveGenerationSources(input: {
  identity: Identity;
  sourceId: string;
  additionalSourceIds?: readonly string[];
  getSource: (id: string) => Promise<SourceRecord | null>;
}): Promise<{ source: SourceRecord; additional: SourceRecord[] }> {
  const { identity, getSource } = input;
  const ids = [...new Set([input.sourceId, ...(input.additionalSourceIds ?? [])])];
  const sources: SourceRecord[] = [];
  for (const id of ids) {
    const source = await getSource(id);
    if (!source || source.tombstonedAt) {
      throw new HttpError(400, `unknown or removed source: ${id}`);
    }
    assertAuthorized(
      identity,
      "dashboard:generate",
      { workspaceId: source.workspaceId },
      { type: "source", id: source.id },
    );
    if (sources.length > 0 && source.workspaceId !== sources[0].workspaceId) {
      throw new HttpError(
        400,
        "every source of one dashboard must be in the same workspace",
      );
    }
    const refusal = catalogRefusal(source, catalogHealth(source));
    if (refusal) throw new HttpError(400, refusal);
    sources.push(source);
  }
  const [source, ...additional] = sources;
  return { source, additional };
}
