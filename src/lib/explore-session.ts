/**
 * The questions asked on one visit to Explore, newest first.
 *
 * Browser-safe and pure, generic over what an entry holds. It lives in React
 * state only: nothing here is stored or sent, so a reload starts a new
 * session, and the rows it holds are the ones the guarded query returned.
 */

/** How many results a session keeps; the oldest unpinned one goes first. */
export const MAX_SESSION_ENTRIES = 20;

export interface SessionEntry {
  id: string;
}

export interface Session<E extends SessionEntry> {
  entries: E[];
  /** The result in the main view. */
  activeId: string | null;
  /** The result held beside it for comparison. */
  pinnedId: string | null;
}

export function emptySession<E extends SessionEntry>(): Session<E> {
  return { entries: [], activeId: null, pinnedId: null };
}

/** A new result goes first and is shown; past the cap the oldest unpinned goes. */
export function addEntry<E extends SessionEntry>(
  session: Session<E>,
  entry: E,
): Session<E> {
  const entries = [entry, ...session.entries];
  while (entries.length > MAX_SESSION_ENTRIES) {
    const drop = entries.findLastIndex((e) => e.id !== session.pinnedId);
    entries.splice(drop, 1);
  }
  return { ...session, entries, activeId: entry.id };
}

/** Change one entry in place; an unknown id changes nothing. */
export function updateEntry<E extends SessionEntry>(
  session: Session<E>,
  id: string,
  update: (entry: E) => E,
): Session<E> {
  if (!session.entries.some((e) => e.id === id)) return session;
  return {
    ...session,
    entries: session.entries.map((e) => (e.id === id ? update(e) : e)),
  };
}

/** Bring a result back into the main view. */
export function showEntry<E extends SessionEntry>(
  session: Session<E>,
  id: string,
): Session<E> {
  return session.entries.some((e) => e.id === id)
    ? { ...session, activeId: id }
    : session;
}

/** Pin a result for comparison, or unpin it if it is the pinned one. */
export function togglePin<E extends SessionEntry>(
  session: Session<E>,
  id: string,
): Session<E> {
  if (session.pinnedId === id) return { ...session, pinnedId: null };
  return session.entries.some((e) => e.id === id)
    ? { ...session, pinnedId: id }
    : session;
}

/** Drop a result; the view falls back to the newest one left. */
export function removeEntry<E extends SessionEntry>(
  session: Session<E>,
  id: string,
): Session<E> {
  const entries = session.entries.filter((e) => e.id !== id);
  return {
    entries,
    activeId: session.activeId === id ? (entries[0]?.id ?? null) : session.activeId,
    pinnedId: session.pinnedId === id ? null : session.pinnedId,
  };
}

/**
 * The results on screen, in order: the pinned one first when it is not the
 * active one, then the active one.
 */
export function visibleEntries<E extends SessionEntry>(session: Session<E>): E[] {
  const find = (id: string | null) => session.entries.find((e) => e.id === id);
  const active = find(session.activeId);
  const pinned =
    session.pinnedId !== session.activeId ? find(session.pinnedId) : undefined;
  return [pinned, active].filter((e): e is E => e !== undefined);
}
