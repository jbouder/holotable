import type { BrowserStorage } from "@/lib/browser-storage";

/**
 * The banner's dismissal in demo mode (#251) and local mode (#600), per
 * viewer in `localStorage`.
 *
 * Browser-local on purpose: a demo visitor's `sub` is minted fresh per
 * session, so a server-side preference would come back after every new
 * session, and this is a convenience, never state anyone else needs. One key
 * per mode, so having dismissed the demo's notice on `localhost` never hides
 * local mode's, which says something different.
 */
export const DEMO_BANNER_KEY = "holotable:demo-banner-dismissed";
export const LOCAL_BANNER_KEY = "holotable:local-banner-dismissed";

/** The modes that show a banner. */
export type BannerMode = "demo" | "local";

const KEYS: Record<BannerMode, string> = {
  demo: DEMO_BANNER_KEY,
  local: LOCAL_BANNER_KEY,
};

export function demoBannerDismissed(
  storage: BrowserStorage | null,
  mode: BannerMode = "demo",
): boolean {
  try {
    return storage?.getItem(KEYS[mode]) === "1";
  } catch {
    return false;
  }
}

export function dismissDemoBanner(
  storage: BrowserStorage | null,
  mode: BannerMode = "demo",
): void {
  try {
    storage?.setItem(KEYS[mode], "1");
  } catch {
    // Private mode or a full quota: the banner simply comes back next load.
  }
}
