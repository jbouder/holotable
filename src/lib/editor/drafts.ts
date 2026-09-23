import { z } from "zod";
import type { BrowserStorage } from "@/lib/browser-storage";
import { browserStorage } from "@/lib/browser-storage";
import { Dashboard } from "@/lib/ir";
import { specFingerprint } from "@/lib/editor/session";

/**
 * Draft autosave for the editor (#118).
 *
 * Editor state lived entirely in React, so a closed tab, a crashed browser or
 * an accidental navigation lost everything since the last save. The working
 * spec is now mirrored into `localStorage` and offered back on the next visit.
 *
 * Three rules make that safe to do:
 *
 * - **Nothing leaves the browser.** A draft is an unvalidated, unexecuted spec
 *   that only its author has seen; it is deliberately not sent to the server,
 *   so the only writes the system makes are still explicit saved versions that
 *   the API re-validates and the SQL guard re-checks. (#118 leaves a
 *   server-side draft table as an explicitly optional, flagged extension; it is
 *   not built here.)
 * - **A draft never silently wins.** It is offered for restore, with a summary
 *   of what it would change; and when the dashboard has moved on underneath it
 *   — someone else saved a version — that is said in as many words instead of
 *   quietly overwriting their work.
 * - **Storage is bounded.** Drafts are per `(dashboardId, userSub)`, capped in
 *   size, and expire; a browser that has drifted through a hundred dashboards
 *   cannot accumulate a hundred specs forever.
 */

/** Shared prefix, so the whole set can be pruned without a separate index. */
export const DRAFT_KEY_PREFIX = "ht_draft:";

/** Beyond this a draft is not written — `localStorage` is a shared, small box. */
export const DRAFT_MAX_BYTES = 256 * 1024;

/** A draft older than this is not worth offering back. */
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Quiet period after the last edit before the working spec is mirrored. */
export const DRAFT_DEBOUNCE_MS = 800;

export const DraftEnvelope = z
  .object({
    dashboardId: z.string().min(1).max(128),
    /** The saved version the draft was derived from; the conflict check reads it. */
    baseVersion: z.number().int().min(0),
    /** Epoch ms of the last autosave. */
    savedAt: z.number().int().min(0),
    spec: Dashboard,
  })
  .strict();
export type DraftEnvelope = z.infer<typeof DraftEnvelope>;

/**
 * One key per dashboard per user.
 *
 * `localStorage` is per origin, not per session, so two people using the same
 * browser share it. Keying by the subject keeps one person's unsaved work from
 * being offered to the next — the value is an opaque identifier already present
 * in the session, and it grants nothing: a forged key surfaces a spec that the
 * server re-authorizes and re-validates before it can become a version.
 */
export function draftKey(dashboardId: string, userSub: string): string {
  return `${DRAFT_KEY_PREFIX}${dashboardId}:${userSub}`;
}

/**
 * The minimum of the Storage API this module uses, so tests can supply one.
 * Shared with recent prompts (#83), which needs exactly the same subset.
 */
export type DraftStorage = BrowserStorage;

/**
 * Reading `localStorage` throws outright in some privacy modes, and the value
 * may be anything at all — another tab, an extension, a previous build. Every
 * access is therefore guarded and every parse goes through the IR.
 */
export function readDraft(
  storage: DraftStorage | null,
  key: string,
): DraftEnvelope | null {
  if (!storage) return null;
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = DraftEnvelope.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Not JSON at all.
  }
  clearDraft(storage, key);
  return null;
}

/** Write a draft. Returns false when it was refused (too large, or unavailable). */
export function writeDraft(
  storage: DraftStorage | null,
  key: string,
  envelope: DraftEnvelope,
): boolean {
  if (!storage) return false;
  const body = JSON.stringify(envelope);
  if (body.length > DRAFT_MAX_BYTES) return false;
  try {
    storage.setItem(key, body);
    return true;
  } catch {
    // Quota exceeded, or storage disabled. A draft is a convenience; losing it
    // must never take the editor down with it.
    return false;
  }
}

export function clearDraft(storage: DraftStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Nothing to do: the draft is already unreachable.
  }
}

/**
 * Drop expired drafts for every dashboard, not just this one.
 *
 * Without this the cap is per key and the total is unbounded: an editor visited
 * once leaves a draft behind that nothing would ever open again.
 */
export function pruneDrafts(storage: DraftStorage | null, now: number): number {
  if (!storage) return 0;
  const stale: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(DRAFT_KEY_PREFIX)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      let savedAt: unknown;
      try {
        savedAt = (JSON.parse(raw) as { savedAt?: unknown }).savedAt;
      } catch {
        stale.push(key);
        continue;
      }
      if (typeof savedAt !== "number" || now - savedAt > DRAFT_TTL_MS) stale.push(key);
    }
  } catch {
    return 0;
  }
  for (const key of stale) clearDraft(storage, key);
  return stale.length;
}

/** One stored draft as the local-data settings list shows it (#216). */
export interface DraftSummary {
  key: string;
  dashboardId: string;
  title: string;
  savedAt: number;
  /** Length of the stored value, which is what counts against the quota. */
  bytes: number;
}

/**
 * Every readable draft that belongs to `userSub`, newest first.
 *
 * A key only counts when it is exactly `draftKey(envelope.dashboardId,
 * userSub)`: matching on a suffix alone would let a subject that ends with
 * another's claim that person's drafts. Other people's drafts on a shared
 * browser are neither listed nor touched, and unreadable values are skipped
 * rather than deleted here, since they may be someone else's.
 */
export function listDrafts(
  storage: DraftStorage | null,
  userSub: string,
): DraftSummary[] {
  if (!storage || !userSub) return [];
  const out: DraftSummary[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(DRAFT_KEY_PREFIX) || !key.endsWith(`:${userSub}`)) continue;
      const raw = storage.getItem(key);
      if (!raw) continue;
      let parsed: ReturnType<typeof DraftEnvelope.safeParse>;
      try {
        parsed = DraftEnvelope.safeParse(JSON.parse(raw));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const { dashboardId, savedAt, spec } = parsed.data;
      if (draftKey(dashboardId, userSub) !== key) continue;
      out.push({ key, dashboardId, title: spec.title, savedAt, bytes: raw.length });
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/** Discard every draft {@link listDrafts} would show for `userSub`. */
export function clearDrafts(storage: DraftStorage | null, userSub: string): number {
  const drafts = listDrafts(storage, userSub);
  for (const { key } of drafts) clearDraft(storage, key);
  return drafts.length;
}

/** What changed between the saved spec and the draft, in the author's terms. */
export interface DraftChanges {
  title: boolean;
  timeRange: boolean;
  refresh: boolean;
  /** Panel titles, taken from whichever side has the panel. */
  added: string[];
  removed: string[];
  changed: string[];
}

export function draftChanges(saved: Dashboard, draft: Dashboard): DraftChanges {
  const savedPanels = new Map(saved.panels.map((p) => [p.id, p]));
  const draftPanels = new Map(draft.panels.map((p) => [p.id, p]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const panel of draft.panels) {
    const before = savedPanels.get(panel.id);
    if (!before) {
      added.push(panel.title);
    } else if (JSON.stringify(before) !== JSON.stringify(panel)) {
      changed.push(panel.title);
    }
  }
  const removed = saved.panels.filter((p) => !draftPanels.has(p.id)).map((p) => p.title);
  return {
    title: saved.title !== draft.title,
    timeRange:
      saved.timeRange.from !== draft.timeRange.from ||
      saved.timeRange.to !== draft.timeRange.to,
    refresh: saved.refreshIntervalMs !== draft.refreshIntervalMs,
    added,
    removed,
    changed,
  };
}

/** A one-line summary of {@link DraftChanges}, or null when nothing changed. */
export function summarizeDraftChanges(changes: DraftChanges): string | null {
  const panels = (n: number, verb: string) => `${n} panel${n === 1 ? "" : "s"} ${verb}`;
  const parts: string[] = [];
  if (changes.added.length) parts.push(panels(changes.added.length, "added"));
  if (changes.removed.length) parts.push(panels(changes.removed.length, "removed"));
  if (changes.changed.length) parts.push(panels(changes.changed.length, "edited"));
  if (changes.title) parts.push("title changed");
  if (changes.timeRange) parts.push("time range changed");
  if (changes.refresh) parts.push("refresh changed");
  return parts.length > 0 ? parts.join(", ") : null;
}

export type DraftOffer =
  | { kind: "none" }
  /** The draft continues the version currently open. */
  | { kind: "restorable"; draft: DraftEnvelope; changes: DraftChanges }
  /** The dashboard advanced past the draft's base version while it sat here. */
  | { kind: "conflict"; draft: DraftEnvelope; changes: DraftChanges };

/**
 * Whether a stored draft should be offered back, and how.
 *
 * A draft is discarded silently when it says nothing new: it is for another
 * dashboard, it has expired, it is ahead of a version that cannot exist, or it
 * is byte-for-byte the spec already on screen. Anything else is shown, because
 * the alternative — deciding on the author's behalf — is how unsaved work gets
 * lost quietly.
 */
export function draftOffer(input: {
  draft: DraftEnvelope | null;
  dashboardId: string;
  currentVersion: number;
  savedSpec: Dashboard;
  now: number;
}): DraftOffer {
  const { draft } = input;
  if (!draft) return { kind: "none" };
  if (draft.dashboardId !== input.dashboardId) return { kind: "none" };
  if (input.now - draft.savedAt > DRAFT_TTL_MS) return { kind: "none" };
  // A base version beyond the dashboard's own is not something this app wrote.
  if (draft.baseVersion > input.currentVersion) return { kind: "none" };
  if (specFingerprint(draft.spec) === specFingerprint(input.savedSpec)) {
    return { kind: "none" };
  }
  const changes = draftChanges(input.savedSpec, draft.spec);
  return draft.baseVersion < input.currentVersion
    ? { kind: "conflict", draft, changes }
    : { kind: "restorable", draft, changes };
}

/** `localStorage` if this browser has one it will actually hand over. */
export function browserDraftStorage(): DraftStorage | null {
  return browserStorage();
}
