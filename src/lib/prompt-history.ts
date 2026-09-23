import type { BrowserStorage } from "@/lib/browser-storage";

/**
 * Recent prompts, per workspace (#83).
 *
 * Generation was one-shot and amnesiac: the prompt box on /dashboards/new
 * started empty every visit, so the sentence that produced a good dashboard
 * last week was gone. This keeps the last few, and offers them back.
 *
 * It stays in the browser on purpose. A prompt is free text someone typed, and
 * the thing this app already does with free text it must keep is redact it and
 * write it to the generation log (#23) — that is the durable, operator-facing
 * record, behind `source:manage`. A convenience list for one person's own box
 * needs no server round trip and no new payload, so it does not get one:
 * nothing here is sent anywhere, and nothing here is authorization. A forged
 * entry puts a sentence in a textarea the author then reads.
 *
 * Everything is a pure function over a {@link BrowserStorage}, so the rules —
 * dedupe, cap, expiry, and refusing to trust what comes back out — are
 * testable without a browser.
 */

/** Shared prefix, so the whole set can be pruned without a separate index. */
export const PROMPT_HISTORY_PREFIX = "ht_prompts:";

/** Entries kept per list. A dropdown, not an archive. */
export const PROMPT_HISTORY_MAX = 15;

/** An entry older than this is not worth offering back. */
export const PROMPT_HISTORY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** Longest prompt stored, matching the cap `/api/generate` enforces. */
export const PROMPT_MAX_LENGTH = 4_000;

/**
 * Which box a prompt was typed into.
 *
 * Keyed alongside the workspace rather than lumped together: "make the third
 * one a bar chart" is a panel edit and is nonsense in the create box, and a
 * list that mixes them is a list nobody reads. Each scope is still per
 * workspace, because a prompt names that workspace's tables.
 */
export type PromptScope = "dashboard" | "panel" | "explore";

export interface RememberedPrompt {
  prompt: string;
  /** Epoch ms it was last used. Re-using an old prompt moves it to the front. */
  at: number;
}

/** One list per workspace per box. */
export function promptHistoryKey(workspaceId: string, scope: PromptScope): string {
  return `${PROMPT_HISTORY_PREFIX}${scope}:${workspaceId}`;
}

/** Whether a value read back out is an entry. Anything else is dropped. */
function isEntry(value: unknown): value is RememberedPrompt {
  if (typeof value !== "object" || value === null) return false;
  const { prompt, at } = value as { prompt?: unknown; at?: unknown };
  return typeof prompt === "string" && prompt.length > 0 && typeof at === "number";
}

/**
 * The usable entries in one list, newest first.
 *
 * The value may be anything at all — another tab, an extension, a previous
 * build — so every access is guarded and every entry is shape-checked. Expiry
 * is applied here rather than only on write, so shortening the window (or
 * simply not generating for three months) takes effect on the next read
 * instead of whenever someone next submits.
 */
export function readPromptHistory(
  storage: BrowserStorage | null,
  key: string,
  now: number,
): RememberedPrompt[] {
  if (!storage) return [];
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearPromptHistory(storage, key);
    return [];
  }
  if (!Array.isArray(parsed)) {
    clearPromptHistory(storage, key);
    return [];
  }
  return parsed
    .filter(isEntry)
    .filter((entry) => now - entry.at <= PROMPT_HISTORY_TTL_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, PROMPT_HISTORY_MAX);
}

/**
 * The list after remembering `prompt`. Pure — {@link rememberPrompt} writes it.
 *
 * A prompt submitted again is moved to the front rather than added twice: the
 * list is "what have I asked for", and the same sentence twice says nothing
 * the first one did not. Comparison is on the trimmed text, because trailing
 * whitespace from a paste is not a different question.
 */
export function withPrompt(
  entries: RememberedPrompt[],
  prompt: string,
  now: number,
): RememberedPrompt[] {
  const text = prompt.trim().slice(0, PROMPT_MAX_LENGTH);
  if (!text) return entries;
  return [
    { prompt: text, at: now },
    ...entries.filter((entry) => entry.prompt !== text),
  ].slice(0, PROMPT_HISTORY_MAX);
}

/**
 * Remember one prompt and return the new list.
 *
 * Called when a generation is SUBMITTED, not when it succeeds: a run that
 * failed, or one whose result the author rejected, is exactly the prompt they
 * are most likely to want back in the box.
 */
export function rememberPrompt(
  storage: BrowserStorage | null,
  key: string,
  prompt: string,
  now: number,
): RememberedPrompt[] {
  const entries = withPrompt(readPromptHistory(storage, key, now), prompt, now);
  if (!storage) return entries;
  try {
    storage.setItem(key, JSON.stringify(entries));
  } catch {
    // Quota exceeded, or storage disabled. Recent prompts are a convenience;
    // losing them must never take the generation down with them.
  }
  return entries;
}

export function clearPromptHistory(storage: BrowserStorage | null, key: string): void {
  if (!storage) return;
  try {
    storage.removeItem(key);
  } catch {
    // Already unreachable.
  }
}

/**
 * Drop expired lists for every workspace, not just this one.
 *
 * Each list is capped, but the number of LISTS is not: a browser that has
 * drifted through thirty workspaces would keep thirty of them forever. Run
 * once on mount, like `pruneDrafts`.
 */
export function prunePromptHistory(storage: BrowserStorage | null, now: number): number {
  if (!storage) return 0;
  const empty: string[] = [];
  try {
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(PROMPT_HISTORY_PREFIX)) continue;
      if (readPromptHistory(storage, key, now).length === 0) empty.push(key);
    }
  } catch {
    return 0;
  }
  for (const key of empty) clearPromptHistory(storage, key);
  return empty.length;
}

/** A prompt as one line in a dropdown: collapsed whitespace, clipped. */
export function promptLabel(prompt: string, max = 80): string {
  const line = prompt.trim().replace(/\s+/g, " ");
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
