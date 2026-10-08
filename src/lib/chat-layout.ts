import type { BrowserStorage } from "@/lib/browser-storage";

/**
 * Whether the dashboard chat opens expanded (#366): docked to the right edge
 * at full height instead of the small floating box. A layout choice for this
 * browser, like the theme, so it is listed in `LOCAL_STORAGE_EXCLUSIONS`
 * rather than cleared with remembered data.
 */
export const CHAT_EXPANDED_KEY = "holotable:chat-expanded";

/** The stored choice; collapsed when nothing is stored or storage refuses. */
export function readChatExpanded(storage: BrowserStorage | null): boolean {
  try {
    return storage?.getItem(CHAT_EXPANDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remember the choice. Collapsed is the default, so it is stored as nothing. */
export function writeChatExpanded(storage: BrowserStorage | null, expanded: boolean) {
  try {
    if (expanded) storage?.setItem(CHAT_EXPANDED_KEY, "1");
    else storage?.removeItem(CHAT_EXPANDED_KEY);
  } catch {
    // A browser that refuses storage simply opens collapsed next time.
  }
}
