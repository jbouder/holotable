/*
 * How a dashboard's tags are folded (#493). Its own module, free of the
 * metadata schemas, because the dashboard list's client components need only
 * this, and importing it from `dashboard-metadata.ts` put zod in their bundle.
 */

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
