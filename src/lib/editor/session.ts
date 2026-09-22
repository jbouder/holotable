import type { Dashboard } from "@/lib/ir";

/**
 * The editor session: what "unsaved" means, and what may leave with it (#117).
 *
 * Saving used to mean PUT-then-navigate, so there was no way to save and keep
 * editing and nothing stood between an accidental Cancel and the loss of a
 * session's work. The guard needs two things that are easier to get right as
 * pure functions than as effects: an honest answer to "has anything actually
 * changed?", and a decision about whether a given click is a navigation worth
 * intercepting.
 */

/**
 * Order-independent serialization of a spec.
 *
 * The dirty flag compares the working spec with the last saved one, and a
 * plain `JSON.stringify` makes that comparison depend on key insertion order —
 * so rebuilding a panel through a spread (which the editor does on every edit)
 * could report a change where none exists. Sorting object keys removes the
 * question. Arrays keep their order, because panel order is meaningful.
 */
export function specFingerprint(spec: Dashboard): string {
  return JSON.stringify(spec, (_key, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, record[k]]),
    );
  });
}

/** Whether the working spec differs from the one last written to the server. */
export function isDirty(working: Dashboard, saved: Dashboard): boolean {
  return specFingerprint(working) !== specFingerprint(saved);
}

/**
 * The prompt the browser shows on unload. Modern browsers ignore the text and
 * show their own wording, but a non-empty `returnValue` is still what asks
 * for the prompt at all.
 */
export const UNLOAD_PROMPT = "You have unsaved changes to this dashboard.";

/** A version note is a short human label, not a place to put a document. */
export const VERSION_NOTE_MAX = 200;

export interface LinkClick {
  /** The anchor's resolved `href`, or null when it has none. */
  href: string | null;
  /** The anchor's `target` attribute. */
  target: string | null;
  download: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  /** `MouseEvent.button`; only the primary button navigates in place. */
  button: number;
  /** `location.origin` of the page the click happened on. */
  origin: string;
  /** `location.pathname` — a link to where we already are is not a departure. */
  currentPath: string;
}

/**
 * The in-app destination a click would navigate to, or null to let it through.
 *
 * The App Router exposes no navigation event to hook, so the unsaved-changes
 * guard intercepts the click that would start the navigation instead. It has to
 * be conservative in one direction only: letting a click through loses the
 * guard, so the rules below exclude exactly the clicks that do NOT replace the
 * current document — a new tab, a download, a modified click, an external
 * origin, a pure fragment.
 */
export function interceptedHref(click: LinkClick): string | null {
  if (click.button !== 0) return null;
  if (click.metaKey || click.ctrlKey || click.shiftKey || click.altKey) return null;
  if (click.download) return null;
  if (click.target && click.target !== "" && click.target !== "_self") return null;
  if (!click.href) return null;

  let url: URL;
  try {
    // Resolved against the page we are ON, not the origin root, so a bare
    // `#panels` stays on this path instead of reading as a link to `/`.
    url = new URL(click.href, `${click.origin}${click.currentPath}`);
  } catch {
    return null;
  }
  if (url.origin !== click.origin) return null;
  // A same-page fragment or a link back to this very page changes nothing that
  // could lose the working spec.
  if (url.pathname === click.currentPath && url.search === "") return null;

  return `${url.pathname}${url.search}${url.hash}`;
}

/** "just now", "3 minutes ago", … for the editor's last-saved line. */
export function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
