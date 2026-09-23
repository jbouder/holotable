import { z } from "zod";
import type { Dashboard } from "@/lib/ir";

/**
 * Dashboard metadata: the description, the tags, and the rules for both.
 *
 * Everything here is *about* a dashboard rather than part of it. The spec IR
 * is the contract execution and rendering run on; a description is prose for
 * people and a tag is a label the list groups by, and neither is ever read by
 * the poller, the guard, or the model. Keeping them on the `dashboards` row
 * instead of in the spec is what lets them change without appending a version
 * — and what keeps them out of an export, where a workspace's own shelf labels
 * would mean nothing.
 *
 * The title is the exception, and deliberately so: see {@link TITLE_AUTHORITY}.
 */

/**
 * **The spec owns the title.**
 *
 * `dashboards.title` is a mirror: `saveDashboardVersion` writes it from
 * `spec.title` on every save, and `createDashboard` from the spec at version
 * 1. A rename therefore cannot be a column update — the next save would
 * silently undo it — so renaming appends a version whose spec differs only in
 * its title, exactly as renaming in the editor always has.
 *
 * The alternative (the row wins, and `saveDashboardVersion` stops copying the
 * title) was rejected: it makes the row and the spec disagree, and the spec is
 * what an export carries, what the chat prompt names, and what the viewer's
 * header reads. Two answers to "what is this dashboard called" is worse than
 * one extra version row.
 */
export const TITLE_AUTHORITY = "spec" as const;

/** Matches the IR's `Panel.description`, which is the same kind of prose. */
export const DESCRIPTION_MAX = 500;

/** A tag is a shelf label, not a sentence. */
export const TAG_MAX = 32;

/**
 * Past a dozen labels a tag list stops being navigation and becomes a second
 * description, so the cap is low enough to force a choice.
 */
export const MAX_TAGS = 12;

/**
 * Fold one tag into its canonical form: trimmed, inner whitespace collapsed,
 * lowercased, and bounded.
 *
 * Case folding is what makes the filter chips usable — `Prod`, `prod` and
 * `PROD` are one shelf, not three — and it has to happen before storage rather
 * than in the query, because `tags @> $1` compares exactly and a GIN index has
 * no opinion about case. Returns `""` for anything that folds to nothing, which
 * {@link normalizeTags} drops.
 */
export function normalizeTag(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").toLowerCase().slice(0, TAG_MAX).trim();
}

/**
 * Fold a whole list: normalize, drop the empties, drop duplicates keeping the
 * first occurrence, then sort and cap.
 *
 * Sorting is what makes two dashboards tagged the same read the same, whoever
 * typed them in and in whatever order. The cap is applied after deduplication
 * so twelve ways of writing `prod` cost one slot rather than all of them.
 */
export function normalizeTags(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const tag of raw) {
    const normalized = normalizeTag(tag);
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort().slice(0, MAX_TAGS);
}

/**
 * Split what someone typed into a tag input into tags.
 *
 * Commas separate; whitespace does not, because `page load` is one label. A
 * trailing comma is how a tag input is normally left mid-typing, so it yields
 * nothing rather than an empty tag.
 */
export function parseTagInput(text: string): string[] {
  return normalizeTags(text.split(","));
}

/** A description as the API accepts it: bounded, and blank means "none". */
export const DashboardDescription = z
  .string()
  .max(DESCRIPTION_MAX)
  .transform((s) => s.trim())
  .transform((s) => (s.length === 0 ? null : s));

/**
 * Tags as the API accepts them.
 *
 * The bound is on the *input* list as well as the normalized one: a caller
 * sending ten thousand tags should be refused rather than quietly reduced to
 * twelve, since silently accepting an absurd body is how a limit becomes
 * untestable.
 */
export const DashboardTags = z
  .array(z.string().max(TAG_MAX * 4))
  .max(MAX_TAGS * 4)
  .transform(normalizeTags);

/** `"Errors"` → `"Errors (copy)"`, kept inside the IR's 200-character title. */
export function copyDashboardTitle(title: string): string {
  const suffix = " (copy)";
  return `${title.slice(0, 200 - suffix.length)}${suffix}`;
}

/**
 * Escape a user's search text for a `LIKE`/`ILIKE` pattern.
 *
 * The text is already a bound parameter, so this is not about injection — it
 * is about meaning: `100%` typed into a search box is three characters, not
 * "anything starting with 100". The escape character is declared by the query
 * with `ESCAPE '\'`, and the backslash itself has to go first or it would
 * escape the escapes added after it.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/* -------------------------------------------------------------------------- */
/* The stored dashboard                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A dashboard as the list shows it: identity, metadata, and which version is
 * current — everything except the spec.
 *
 * It lives here rather than beside the SQL that reads it because the list card
 * and the details dialog are client components, and a type imported from the
 * repository would put `pg` on the import graph of the browser bundle.
 */
export interface DashboardSummary {
  id: string;
  workspaceId: string;
  /** Mirrored from `spec.title`; see {@link TITLE_AUTHORITY}. */
  title: string;
  description: string | null;
  tags: string[];
  createdBy: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /**
   * Whether the identity the row was read for has starred it. False when it
   * was read without one — favouriting is per person, so there is no answer.
   */
  favorite: boolean;
}

/** A summary plus the current version's validated spec. */
export interface DashboardRecord extends DashboardSummary {
  spec: Dashboard;
}
