import type { BrowserStorage } from "@/lib/browser-storage";
import { clearRecents, parseRecents, RECENTS_STORAGE_KEY } from "@/lib/command-palette";
import { clearRecent, readRecent, RECENT_KEY } from "@/lib/dashboard-list";
import { SETUP_DISMISSED_COOKIE } from "@/lib/dismissals";
import { clearDrafts, DRAFT_KEY_PREFIX, listDrafts } from "@/lib/editor/drafts";
import {
  clearAllPromptHistory,
  countPromptHistory,
  PROMPT_HISTORY_PREFIX,
} from "@/lib/prompt-history";
import { THEME_STORAGE_KEY } from "@/lib/theme";

/**
 * Everything this browser remembers for Holotable, in one list (#216).
 *
 * Each feature keeps its own key and its own clear function next to it; this
 * module only registers them, so the local-data settings section never names a
 * key itself. `test/local-data.test.ts` scans the source for every place that
 * writes browser storage or a cookie and fails when one is not accounted for
 * here, either as a store or as a deliberate exclusion.
 *
 * Nothing here is authorization. Clearing a store forgets a convenience; it
 * never grants or revokes anything.
 */

export interface LocalStoreContext {
  /** The signed-in subject. Drafts are keyed by it, and only theirs are touched. */
  userSub: string;
  now: number;
}

export type KeyMatch = { exact: string } | { prefix: string };

export type LocalStoreId = "drafts" | "prompts" | "recent-dashboards" | "palette-recents";

export interface LocalStore {
  id: LocalStoreId;
  label: string;
  description: string;
  /** What `count` is a count of, singular and plural. */
  unit: [string, string];
  keys: KeyMatch[];
  count(storage: BrowserStorage | null, ctx: LocalStoreContext): number;
  clear(storage: BrowserStorage | null, ctx: LocalStoreContext): void;
}

export const LOCAL_STORES: readonly LocalStore[] = [
  {
    id: "drafts",
    label: "Editor drafts",
    description:
      "Unsaved dashboard edits, autosaved so a closed tab does not lose them. Only yours are shown.",
    unit: ["draft", "drafts"],
    keys: [{ prefix: DRAFT_KEY_PREFIX }],
    count: (storage, ctx) => listDrafts(storage, ctx.userSub).length,
    clear: (storage, ctx) => void clearDrafts(storage, ctx.userSub),
  },
  {
    id: "prompts",
    label: "Recent prompts",
    description:
      "What you asked the model for, offered back in the prompt boxes. Kept per workspace.",
    unit: ["prompt", "prompts"],
    keys: [{ prefix: PROMPT_HISTORY_PREFIX }],
    count: (storage, ctx) => countPromptHistory(storage, ctx.now),
    clear: (storage) => clearAllPromptHistory(storage),
  },
  {
    id: "recent-dashboards",
    label: "Recently viewed dashboards",
    description: "The shortcut row at the top of the dashboard list.",
    unit: ["dashboard", "dashboards"],
    keys: [{ exact: RECENT_KEY }],
    count: (storage) => readRecent(storage ?? undefined).length,
    clear: (storage) => clearRecent(storage),
  },
  {
    id: "palette-recents",
    label: "Command palette history",
    description: "The commands the palette lists first when nothing is typed.",
    unit: ["command", "commands"],
    keys: [{ exact: RECENTS_STORAGE_KEY }],
    count: (storage) => {
      try {
        return parseRecents(storage?.getItem(RECENTS_STORAGE_KEY) ?? null).length;
      } catch {
        return 0;
      }
    },
    clear: (storage) => clearRecents(storage),
  },
];

/**
 * Browser storage that is deliberately not cleared from this section, and why.
 * Listed so the coverage test can tell "left out on purpose" from "forgotten".
 */
export const LOCAL_STORAGE_EXCLUSIONS: readonly { key: KeyMatch; reason: string }[] = [
  {
    key: { exact: THEME_STORAGE_KEY },
    reason: "The theme is a preference, changed under Appearance, not remembered data.",
  },
];

/** Cookies this section can reset, through the allowlisted dismissal action. */
export const LOCAL_COOKIES: readonly {
  name: string;
  label: string;
  description: string;
}[] = [
  {
    name: SETUP_DISMISSED_COOKIE,
    label: "Setup hints",
    description: "The first-run guide on an empty dashboard list, once you dismiss it.",
  },
];

/**
 * Cookies that are not this section's to clear. The session and the sign-in
 * handshake belong to Sign out and the login flow.
 */
export const COOKIE_EXCLUSIONS: readonly { name: string; reason: string }[] = [
  {
    name: "holotable_session",
    reason: "The session cookie (SESSION_COOKIE_NAME); Sign out clears it.",
  },
  { name: "holotable_oidc_state", reason: "Sign-in handshake, deleted by the callback." },
  { name: "holotable_oidc_nonce", reason: "Sign-in handshake, short-lived." },
];

export function keyMatches(match: KeyMatch, key: string): boolean {
  return "exact" in match ? key === match.exact : key.startsWith(match.prefix);
}

/** The store that owns `key`, if any. */
export function storeForKey(key: string): LocalStore | null {
  return LOCAL_STORES.find((s) => s.keys.some((m) => keyMatches(m, key))) ?? null;
}

/** Clear every registered store. Excluded keys and other people's drafts stay. */
export function clearAllLocalData(
  storage: BrowserStorage | null,
  ctx: LocalStoreContext,
): void {
  for (const store of LOCAL_STORES) store.clear(storage, ctx);
}

/** "3 drafts", "1 prompt", "Empty". */
export function describeCount(store: Pick<LocalStore, "unit">, n: number): string {
  if (n === 0) return "Empty";
  return `${n} ${n === 1 ? store.unit[0] : store.unit[1]}`;
}
