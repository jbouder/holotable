/**
 * The browser's half of session renewal (#27).
 *
 * The session cookie is httpOnly, so the page never sees the token; it knows
 * only when the token expires (the root layout passes that down) and asks
 * `POST /api/auth/refresh` for a new one shortly before. Several things may
 * ask at once — the keepalive's timer, a stream that just lost its session,
 * the sign-in card — so a tab shares one request in flight, announces every
 * outcome on a window event, and tells its other tabs through `localStorage`
 * when it has pushed the expiry out, so they do not all renew too.
 */

export const SESSION_EVENT = "holotable:session";
export const SESSION_EXPIRY_KEY = "holotable:session-expires-at";
/** sessionStorage: when the sign-in card last tried a silent renewal. */
export const RESUME_ATTEMPT_KEY = "holotable:resume-attempted-at";

export type RenewResult =
  | { ok: true; expiresAt: number }
  /** `ended`: sign in again. Otherwise the server could not renew right now. */
  | { ok: false; ended: boolean };

/** Never renew sooner than this after scheduling, unless already expired. */
const MIN_DELAY_MS = 5_000;
const MAX_LEAD_MS = 60_000;

/**
 * How long to wait before renewing a token that expires at `expiresAt`: a
 * minute early, or a quarter of what is left when that is less, so a short
 * token is not renewed the instant it arrives.
 */
export function renewalDelay(expiresAt: number, now: number): number {
  const remaining = expiresAt - now;
  if (remaining <= 0) return 0;
  const lead = Math.min(MAX_LEAD_MS, remaining / 4);
  return Math.max(Math.min(MIN_DELAY_MS, remaining), remaining - lead);
}

/** The response, read for its status and nothing it does not need. */
export async function readRenewResponse(res: Response): Promise<RenewResult> {
  if (res.status === 401) return { ok: false, ended: true };
  if (!res.ok) return { ok: false, ended: false };
  try {
    const body = (await res.json()) as { expiresAt?: unknown };
    return typeof body.expiresAt === "number"
      ? { ok: true, expiresAt: body.expiresAt }
      : { ok: false, ended: false };
  } catch {
    return { ok: false, ended: false };
  }
}

let inflight: Promise<RenewResult> | null = null;

/** Renew now. Concurrent callers in one tab share the request. */
export function renewSession(): Promise<RenewResult> {
  if (!inflight) {
    inflight = (async () => {
      let result: RenewResult;
      try {
        result = await readRenewResponse(
          await fetch("/api/auth/refresh", { method: "POST", cache: "no-store" }),
        );
      } catch {
        result = { ok: false, ended: false };
      }
      if (result.ok) writeSharedExpiry(result.expiresAt);
      window.dispatchEvent(
        new CustomEvent<RenewResult>(SESSION_EVENT, { detail: result }),
      );
      return result;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

/**
 * Margin under which a session counts as already over: a stream reconnecting
 * on a token with less left than this would only be ended again at once.
 */
const FRESH_ENOUGH_MS = 10_000;

/**
 * A session good for a while yet, for a stream whose token just expired
 * (#32). The keepalive renews about a minute before the cookie's token runs
 * out, so usually this tab or another has already renewed and the stream only
 * has to reconnect; renewing again would spend a refresh grant for nothing.
 */
export function ensureSession(now = Date.now()): Promise<RenewResult> {
  const shared = readSharedExpiry();
  if (shared !== null && shared - now > FRESH_ENOUGH_MS) {
    return Promise.resolve({ ok: true, expiresAt: shared });
  }
  return renewSession();
}

/** Another tab's renewal, when it reached further than this tab knows. */
export function readSharedExpiry(): number | null {
  try {
    const raw = window.localStorage.getItem(SESSION_EXPIRY_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeSharedExpiry(expiresAt: number): void {
  try {
    window.localStorage.setItem(SESSION_EXPIRY_KEY, String(expiresAt));
  } catch {
    /* storage unavailable: each tab renews for itself */
  }
}
