/**
 * Per-browser "I have seen this" flags.
 *
 * Cookies rather than `localStorage`, because both surfaces that use one are
 * server-rendered: the server can read a cookie while rendering, so a
 * dismissed hint is simply never emitted. With `localStorage` the guided flow
 * would render, then vanish on hydration — a flash of setup instructions on
 * every visit for exactly the person who said they were done with them.
 *
 * None of this is authorization. A forged value hides a hint and grants
 * nothing, and no API route reads these names.
 */

/** The first-run flow on an empty dashboard list. */
export const SETUP_DISMISSED_COOKIE = "ht_setup_dismissed";

/** The "How it works" explainer inside it. */
export const HOW_IT_WORKS_DISMISSED_COOKIE = "ht_how_it_works_dismissed";

/**
 * The names {@link dismissCookie} will write. A server action is a public
 * endpoint and its arguments come from the browser, so the action must not be
 * usable as a general-purpose "set any cookie" call — that is how a preference
 * turns into a way to plant a session or CSRF cookie of someone's choosing.
 */
export const DISMISSIBLE = new Set<string>([
  SETUP_DISMISSED_COOKIE,
  HOW_IT_WORKS_DISMISSED_COOKIE,
]);

export const DISMISSAL_MAX_AGE_SECONDS = 31_536_000;

/** Whether a cookie value read on the server means "dismissed". */
export function isDismissed(value: string | undefined): boolean {
  return value === "1";
}
