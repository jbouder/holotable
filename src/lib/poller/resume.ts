/**
 * The SSE event id a dashboard stream sends, and reads back on reconnect (#43).
 *
 * The id is the subscriber's own delta cursors — for each time-series panel,
 * the newest timestamp it has been sent — plus the spec version they belong
 * to. `EventSource` remembers the last id it saw and sends it back as
 * `Last-Event-ID` when it reconnects by itself; a page that builds a new
 * `EventSource` passes it as `?lastEventId=`. Either way the server can then
 * send only the rows the browser has not seen.
 *
 * Not a secret and not trusted: a browser can send any id it likes, and the
 * worst it can do is ask for rows it was already allowed to see, again or
 * not at all. So decoding is strict about shape and size, and anything it
 * does not like is simply no resume — a full snapshot, never an error.
 */

/** Larger than any honest id for a 50-panel dashboard; a header cap, not a target. */
export const MAX_RESUME_TOKEN_CHARS = 8_192;
/** An ISO timestamp is 24; this leaves room for other sortable cursor values. */
const MAX_CURSOR_CHARS = 64;

interface Token {
  v: number;
  c: Record<string, string>;
}

export function encodeResumeToken(
  version: number,
  cursors: ReadonlyMap<string, string>,
): string {
  const token: Token = { v: version, c: Object.fromEntries(cursors) };
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64url");
}

/**
 * The cursors to resume from, or null for a full snapshot: no id, one that
 * does not parse, one from another spec version (its panels and cursors may
 * not mean the same thing any more), or one that is too large. Cursors for
 * panels the spec does not have are dropped.
 */
export function decodeResumeToken(
  raw: string | null | undefined,
  version: number,
  panelIds: ReadonlySet<string>,
): Map<string, string> | null {
  if (!raw || raw.length > MAX_RESUME_TOKEN_CHARS || !/^[A-Za-z0-9_-]+$/.test(raw)) {
    return null;
  }
  let token: unknown;
  try {
    token = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof token !== "object" || token === null) return null;
  const { v, c } = token as Partial<Token>;
  if (v !== version || typeof c !== "object" || c === null || Array.isArray(c))
    return null;

  const cursors = new Map<string, string>();
  for (const [panelId, cursor] of Object.entries(c)) {
    if (!panelIds.has(panelId)) continue;
    if (typeof cursor !== "string" || cursor === "" || cursor.length > MAX_CURSOR_CHARS) {
      continue;
    }
    cursors.set(panelId, cursor);
  }
  return cursors;
}
