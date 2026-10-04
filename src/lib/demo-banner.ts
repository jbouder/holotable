import type { BrowserStorage } from "@/lib/browser-storage";

/**
 * The demo-mode banner's dismissal (#251), per viewer in `localStorage`.
 *
 * Browser-local on purpose: a demo visitor's `sub` is minted fresh per
 * session, so a server-side preference would come back after every new
 * session, and this is a convenience, never state anyone else needs.
 */
export const DEMO_BANNER_KEY = "holotable:demo-banner-dismissed";

export function demoBannerDismissed(storage: BrowserStorage | null): boolean {
  try {
    return storage?.getItem(DEMO_BANNER_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissDemoBanner(storage: BrowserStorage | null): void {
  try {
    storage?.setItem(DEMO_BANNER_KEY, "1");
  } catch {
    // Private mode or a full quota: the banner simply comes back next load.
  }
}
