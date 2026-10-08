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

/** The sources a generation reads: the first one picked, and the others. */
export interface SourceSelection {
  primaryId: string | null;
  additionalIds: string[];
}

/**
 * Tick or untick one source in the single list the form shows. The first one
 * picked is the primary and the rest are its others, so unticking the primary
 * promotes the next. A tick in another workspace starts the selection over
 * with that source, since a dashboard belongs to one; a tick past the cap, and
 * unticking the last source, are ignored.
 */
export function toggleSource(
  sources: readonly PickableSource[],
  selection: SourceSelection,
  id: string,
  checked: boolean,
): SourceSelection {
  const { primaryId, additionalIds } = selection;
  const unchanged = { primaryId, additionalIds: [...additionalIds] };
  if (!checked) {
    if (id === primaryId) {
      const [next, ...rest] = additionalIds;
      return next ? { primaryId: next, additionalIds: rest } : unchanged;
    }
    return { primaryId, additionalIds: additionalIds.filter((s) => s !== id) };
  }
  const picked = sources.find((s) => s.id === id);
  if (!picked || id === primaryId || additionalIds.includes(id)) return unchanged;
  const primary = sources.find((s) => s.id === primaryId);
  if (!primary || primary.workspaceId !== picked.workspaceId) {
    return { primaryId: id, additionalIds: [] };
  }
  if (additionalIds.length >= MAX_ADDITIONAL_SOURCES) return unchanged;
  return { primaryId, additionalIds: [...additionalIds, id] };
}

/** Whether {@link toggleSource} would do anything for this source. */
export function canToggleSource(
  sources: readonly PickableSource[],
  selection: SourceSelection,
  id: string,
): boolean {
  const checked = id === selection.primaryId || selection.additionalIds.includes(id);
  const next = toggleSource(sources, selection, id, !checked);
  return (
    next.primaryId !== selection.primaryId ||
    next.additionalIds.join() !== selection.additionalIds.join()
  );
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

/**
 * Where `/dashboards/new` remembers the last source an author generated
 * against (#356). A per-browser convenience, like recent prompts: the id is
 * read back as untrusted and only ever used to pick from the list the server
 * already authorized, so a stale or forged value just falls through.
 */
export const LAST_SOURCE_KEY = "holotable:last-source";

/** The source to start on: the remembered one if still offered, else the first. */
export function defaultSourceId(
  sources: readonly { id: string }[],
  remembered: string | null | undefined,
): string | null {
  if (remembered && sources.some((s) => s.id === remembered)) return remembered;
  return sources[0]?.id ?? null;
}

/** Read the remembered source; never throws, whatever the storage does. */
export function readLastSource(storage: Pick<Storage, "getItem"> | null): string | null {
  try {
    const value = storage?.getItem(LAST_SOURCE_KEY) ?? null;
    // An id is short; anything else in that key is not one of ours.
    return value && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}

/** Forget the remembered source, from the local-data settings (#216). */
export function forgetLastSource(storage: Pick<Storage, "removeItem"> | null): void {
  try {
    storage?.removeItem(LAST_SOURCE_KEY);
  } catch {
    // Nothing to do: the key is gone or unreachable either way.
  }
}

/** Remember a source; a storage that refuses is not an error worth surfacing. */
export function writeLastSource(
  storage: Pick<Storage, "setItem"> | null,
  sourceId: string,
): void {
  try {
    storage?.setItem(LAST_SOURCE_KEY, sourceId);
  } catch {
    // Private mode or a full quota: the default is simply the first source.
  }
}
