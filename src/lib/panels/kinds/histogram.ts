import { z } from "zod";
import { NumberFields } from "@/lib/panels/presentation";
import { Thresholds } from "@/lib/panels/thresholds";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

export const HistogramOptions = z
  .object({
    /**
     * The bucket column: a bucket's lower bound, or its label. By default
     * `le` when `cumulative` and the result has one, else the first column
     * other than the time field.
     */
    bucket: Column.optional(),
    /** The count column; by default the first numeric column that is not the bucket. */
    count: Column.optional(),
    /**
     * The buckets are upper bounds with cumulative counts (a Prometheus
     * classic histogram's `le`): each bar is the difference from the bound
     * below it.
     */
    cumulative: z.boolean().optional(),
    /** A logarithmic count axis, for a long tail. */
    log: z.boolean().optional(),
    /** Color each bar by its bucket's lower bound: an SLO line, drawn as color. */
    thresholds: Thresholds.optional(),
    /** How the bucket bounds are written; the counts are plain numbers. */
    ...NumberFields,
  })
  .strict();
export type HistogramOptions = z.infer<typeof HistogramOptions>;

/** A value distribution as bars (#404). */
export const histogram = definePanelKind({
  kind: "histogram",
  summary:
    "A value distribution: one bar per bucket, counts summed across rows. With `options.cumulative`, the buckets are upper bounds with cumulative counts (a Prometheus `le`).",
  promptHint:
    "how a value is distributed (latency, payload size, queue depth), where a percentile line hides the shape: return a bucket column (its lower bound, e.g. floor(duration_ms / 50) * 50 AS bucket) and a count; add a coarse time bucket (time_bucket('5 minutes', ts)) as 'query.timeField' so the window applies; the counts are summed per bucket across it. options.bucket and options.count name the columns; options.thresholds colors bars from a bound (an SLO).",
  promqlHint:
    "an instant query ('instant': true) over a classic histogram's buckets, 'sum by (le) (increase(<name>_bucket[1h]))', with options.cumulative true and options.bucket \"le\".",
  canvas: true,
  timeBrush: false,
  skeleton: "chart",
  query: "required",
  options: HistogramOptions,
  optionGroups: ["number", "thresholds"],
});
