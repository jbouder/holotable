/**
 * Picking a dashboard's other sources on `/dashboards/new` (#104).
 *
 * Browser-safe and pure, so the rules are tested as functions: the others
 * are sources in the primary's workspace (a dashboard belongs to one), never
 * the primary itself, and at most {@link MAX_ADDITIONAL_SOURCES} of them.
 * The route re-checks all of it against the registry; this only keeps the
 * form from offering what it would refuse.
 */

/** Besides the primary; three sources in all per generation. */
export const MAX_ADDITIONAL_SOURCES = 2;

interface PickableSource {
  id: string;
  workspaceId: string;
}

/** The sources that may be added beside `primaryId`, in the order given. */
export function additionalSourceChoices<T extends PickableSource>(
  sources: readonly T[],
  primaryId: string | null,
): T[] {
  const primary = sources.find((s) => s.id === primaryId);
  if (!primary) return [];
  return sources.filter(
    (s) => s.workspaceId === primary.workspaceId && s.id !== primary.id,
  );
}

/** Tick or untick one; a tick past the cap is ignored. */
export function toggleAdditionalSource(
  selected: readonly string[],
  id: string,
  checked: boolean,
): string[] {
  if (!checked) return selected.filter((s) => s !== id);
  if (selected.includes(id) || selected.length >= MAX_ADDITIONAL_SOURCES) {
    return [...selected];
  }
  return [...selected, id];
}

/** What is still valid after the primary changed. */
export function pruneAdditionalSources(
  selected: readonly string[],
  sources: readonly PickableSource[],
  primaryId: string | null,
): string[] {
  const allowed = new Set(additionalSourceChoices(sources, primaryId).map((s) => s.id));
  return selected.filter((id) => allowed.has(id)).slice(0, MAX_ADDITIONAL_SOURCES);
}
