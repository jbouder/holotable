import type { Panel } from "@/lib/ir";
import { PanelCardSkeleton } from "@/components/dashboard/PanelSkeleton";

/**
 * A panel as it looks part-way through a generation: the fields that have
 * streamed in so far, and nothing else. Narrowed from the IR's `Panel` rather
 * than written out again, so it cannot drift from it (invariant 1).
 */
export type StreamingPanel = Partial<Pick<Panel, "title" | "viz">>;

/** How many cards to draw before the model has named a single panel. */
const PLACEHOLDERS = 4;

/**
 * The dashboard being written, as panel-shaped cards.
 *
 * What used to sit here was a live-updating `JSON.stringify` of the partial
 * spec, which is the one view of a generation that tells the reader nothing
 * about the dashboard they asked for (#72). Each card fills in as its title
 * and viz arrive, so the shape of the answer is visible while it is still
 * being written — and nothing here renders a value: the model produces the
 * spec, the server runs the queries, and the numbers only appear on Preview.
 */
export function GeneratingPanels({
  panels,
}: {
  panels: readonly (StreamingPanel | undefined)[] | undefined;
}) {
  const known = panels ?? [];
  // Never shrink below the placeholder count: a spec that has produced one
  // panel so far is still being written, and a single card that keeps being
  // joined by others is jumpier than a row that fills in.
  const count = Math.max(known.length, PLACEHOLDERS);

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        {Array.from({ length: count }, (_, i) => (
          <PanelCardSkeleton
            // Positional by nature: card `i` is "the i-th panel of this spec",
            // and the stream only ever appends.
            // biome-ignore lint/suspicious/noArrayIndexKey: positions in a streaming spec
            key={i}
            title={known[i]?.title}
            viz={known[i]?.viz}
          />
        ))}
      </div>
      <span role="status" className="sr-only">
        Generating {known.length > 0 ? `${known.length} panels` : "a dashboard"}…
      </span>
    </>
  );
}
