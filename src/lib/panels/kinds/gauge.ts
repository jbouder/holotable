import { z } from "zod";
import { NumberFields } from "@/lib/panels/presentation";
import { Thresholds } from "@/lib/panels/thresholds";
import { definePanelKind } from "@/lib/panels/types";

const Column = z.string().min(1).max(128);

/** A bound: a literal number, or the name of a result column that holds it. */
const Bound = z.union([z.number(), Column]);

export const GaugeOptions = z
  .object({
    /** `radial` (the default): one dial. `bar`: one horizontal bar per row. */
    variant: z.enum(["radial", "bar"]).optional(),
    /** The column shown; by default the first numeric one, as for `stat`. */
    value: Column.optional(),
    /** Defaults to 0. */
    min: Bound.optional(),
    /** Defaults to 100. */
    max: Bound.optional(),
    thresholds: Thresholds.optional(),
    ...NumberFields,
  })
  .strict()
  .superRefine((o, ctx) => {
    if (typeof o.min === "number" && typeof o.max === "number" && o.min >= o.max) {
      ctx.addIssue({ code: "custom", message: "min must be below max", path: ["max"] });
    }
  });
export type GaugeOptions = z.infer<typeof GaugeOptions>;

/** One value against its limits (#200). */
export const gauge = definePanelKind({
  kind: "gauge",
  summary:
    'One value against its limits (`options.min`/`options.max`), as a dial or, with `options.variant: "bar"`, one bar per row. Colored by `options.thresholds`.',
  promptHint:
    "a value with natural bounds (a percentage, utilization, saturation, a quota or budget left): the latest row is shown against options.min and options.max (numbers, or result column names; default 0 and 100), colored by options.thresholds ([{value, color}] ascending). options.variant \"bar\" draws one bar per row of a label column, e.g. one per host. Use 'stat' instead for an unbounded count.",
  promqlHint:
    "an instant query ('instant': true) for a value with natural bounds, against options.min and options.max; options.variant \"bar\" draws one bar per series.",
  canvas: true,
  timeBrush: false,
  skeleton: "ring",
  query: "required",
  options: GaugeOptions,
  optionGroups: ["number", "thresholds"],
});
