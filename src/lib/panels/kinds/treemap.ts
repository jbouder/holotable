import { z } from "zod";
import { NumberFields } from "@/lib/panels/presentation";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

/** The deepest hierarchy a treemap draws: five levels is already hard to read. */
export const TREEMAP_DEPTH_MAX = 5;

export const TreemapOptions = z
  .object({
    /**
     * The path from the top level down, as columns: `["region", "host"]`. By
     * default every text column other than the time field, in result order.
     */
    path: z.array(Column).min(1).max(TREEMAP_DEPTH_MAX).optional(),
    /** The size of each leaf; by default the first numeric column. */
    value: Column.optional(),
    /** Nested rectangles (the default), or rings from the center out. */
    variant: z.enum(["treemap", "sunburst"]).optional(),
    /** How a value is written in labels and tooltips. */
    ...NumberFields,
  })
  .strict();
export type TreemapOptions = z.infer<typeof TreemapOptions>;

/** Hierarchical share: what the whole is made of, level by level (#404). */
export const treemap = definePanelKind({
  kind: "treemap",
  summary:
    'Hierarchical share: nested rectangles sized by value, one level per `options.path` column, or rings with `options.variant: "sunburst"`.',
  promptHint:
    "what a whole is made of, level by level (disk by region then host, requests by route then status, cost by team then service): return one row per leaf with its path columns and one numeric value, already aggregated (rows with the same path are summed); name them in options.path (top level first) and options.value. options.variant \"sunburst\" draws rings. Use 'pie' for one level with a handful of parts.",
  promqlHint:
    'an instant query aggregated by the levels, \'sum by (job, instance) (…)\', with options.path ["job", "instance"] and options.value "value".',
  canvas: true,
  timeBrush: false,
  skeleton: "chart",
  query: "required",
  options: TreemapOptions,
  optionGroups: ["number"],
});
