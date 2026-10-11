import { formatValue } from "@/lib/format";

/**
 * Where a result was cut short (#486), in the order the stages run:
 *
 * - `rows`: the guard's `MAX_QUERY_ROWS` cap. With a time field the newest
 *   rows are kept and `total` is exact; without one the first rows are, and
 *   `total` is unknown.
 * - `bytes`: `MAX_RESULT_BYTES`. Today a result over it fails the panel;
 *   phase 8 (#492) keeps what fits and says so here.
 * - `points`: `PROMQL_MAX_POINTS` widened a PromQL step, so the window is
 *   drawn at a coarser resolution than the source has. `total` is how many
 *   points the finest step would have drawn.
 * - `window`: the browser's `MAX_WINDOW_POINTS` kept the newest rows of
 *   what the server sent.
 *
 * A result, never a spec: it travels on the stream frame and the chat panel's
 * result, and no `SPEC_VERSION` change is involved.
 */
export const TRUNCATION_STAGES = ["rows", "bytes", "points", "window"] as const;
export type TruncationStage = (typeof TRUNCATION_STAGES)[number];

export interface Truncation {
  stage: TruncationStage;
  kept: number;
  total?: number;
}

const count = (n: number) => formatValue(n, "number");

/**
 * The truncation on an SSE frame or a chat result, read as untrusted input
 * like the rest of the frame: anything not shaped like one is no truncation.
 */
export function readTruncation(value: unknown): Truncation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { stage, kept, total } = value as Record<string, unknown>;
  if (!TRUNCATION_STAGES.includes(stage as TruncationStage)) return undefined;
  if (typeof kept !== "number" || !Number.isFinite(kept) || kept < 0) return undefined;
  const t: Truncation = { stage: stage as TruncationStage, kept };
  if (typeof total === "number" && Number.isFinite(total) && total > kept)
    t.total = total;
  return t;
}

/**
 * What the panel's badge says, and the sentence behind it. Short enough for
 * a panel header; the detail names the setting, so an operator knows what to
 * change and an author knows what to narrow.
 */
export function describeTruncation(t: Truncation): { label: string; detail: string } {
  const of = t.total !== undefined ? ` of ${count(t.total)}` : "";
  switch (t.stage) {
    case "rows":
      return t.total !== undefined
        ? {
            label: `Newest ${count(t.kept)}${of} rows`,
            detail: `The query returned more rows than MAX_QUERY_ROWS allows, so the oldest were dropped. Narrow the window or aggregate with a coarser time bucket to see them all.`,
          }
        : {
            label: `First ${count(t.kept)} rows`,
            detail: `The query returned more rows than MAX_QUERY_ROWS allows. It has no time field, so the first ${count(t.kept)} were kept; add a filter or an aggregate to see the rest.`,
          };
    case "bytes":
      return {
        label: `First ${count(t.kept)} rows`,
        detail: `The result was larger than MAX_RESULT_BYTES, so only the rows that fit are shown. Select fewer columns or aggregate.`,
      };
    case "points":
      return {
        label: `${count(t.kept)}${of} points`,
        detail: `The window holds more points than PROMQL_MAX_POINTS allows per series, so the step was widened and each point covers a longer span. A shorter window shows the finer resolution.`,
      };
    case "window":
      return {
        label: `Newest ${count(t.kept)}${of} rows`,
        detail: `A panel holds at most MAX_WINDOW_POINTS rows, so the oldest rows were dropped. A shorter window or a coarser bucket shows the whole range.`,
      };
  }
}
