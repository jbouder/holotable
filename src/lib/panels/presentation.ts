import { z } from "zod";
import { Thresholds } from "@/lib/panels/thresholds";

/**
 * The presentation options several kinds share (#115), as schema fragments a
 * kind spreads into its own strict options object. A kind lists the groups it
 * takes in `optionGroups`, which is what the editor draws controls for; a test
 * holds each listed group's fields to the kind's schema.
 *
 * Everything is optional, and a panel without options renders exactly as it
 * did before they existed.
 */

const Column = z.string().min(1).max(128);

/**
 * How a value is written. Here rather than in `src/lib/ir.ts`, which re-exports
 * it as `panel.format`, because a table column takes one too and nothing under
 * `src/lib/panels/` may import the IR.
 */
export const ValueFormat = z.enum(["number", "bytes", "percent", "ms"]);
export type ValueFormat = z.infer<typeof ValueFormat>;

/** How a number is written: on a stat, in a tooltip, on an axis, in a cell. */
export const NumberFields = {
  /** Digits after the point, fixed. By default the format's own rounding. */
  decimals: z.number().int().min(0).max(6).optional(),
  /** A label after the number: `req/s`, `hosts`. */
  unit: z.string().min(1).max(16).optional(),
  /** `1.2K` rather than `1,234`. Ignored by `bytes`, which is compact already. */
  compact: z.boolean().optional(),
};

/** The fields of {@link NumberFields} as a value. */
export interface NumberDisplay {
  decimals?: number;
  unit?: string;
  compact?: boolean;
}

/** Where the legend sits, or `none` for no legend. */
export const LegendPosition = z.enum(["top", "bottom", "right", "none"]);
export type LegendPosition = z.infer<typeof LegendPosition>;

export const LegendFields = {
  /** Defaults to `top`. */
  legend: LegendPosition.optional(),
};

export const YAxis = z
  .object({
    min: z.number().optional(),
    max: z.number().optional(),
    /** A log10 scale. Values at or below zero cannot be drawn on one. */
    log: z.boolean().optional(),
    /** The axis title. */
    label: z.string().min(1).max(64).optional(),
  })
  .strict()
  .superRefine((axis, ctx) => {
    if (axis.min !== undefined && axis.max !== undefined && axis.min >= axis.max) {
      ctx.addIssue({ code: "custom", message: "min must be below max", path: ["max"] });
    }
    if (axis.log && axis.min !== undefined && axis.min <= 0) {
      ctx.addIssue({
        code: "custom",
        message: "a log axis starts above zero",
        path: ["min"],
      });
    }
  });
export type YAxis = z.infer<typeof YAxis>;

/** The time-series kinds' options: `line`, `area` and `bar`. */
export const SeriesOptions = z
  .object({
    ...NumberFields,
    ...LegendFields,
    yAxis: YAxis.optional(),
    /** Series drawn on top of each other rather than side by side. */
    stacked: z.boolean().optional(),
    /** Points, segments and bars take the color of the step their value is in. */
    thresholds: Thresholds.optional(),
  })
  .strict();
export type SeriesOptions = z.infer<typeof SeriesOptions>;

export const StatOptions = z
  .object({
    ...NumberFields,
    /** The column shown. By default the last row's first numeric column. */
    value: Column.optional(),
    /** The number takes the color of the step its value is in. */
    thresholds: Thresholds.optional(),
    /** The value column across every row, drawn behind the number. */
    sparkline: z.boolean().optional(),
  })
  .strict();
export type StatOptions = z.infer<typeof StatOptions>;

/** The proportional kinds' options: `pie` and `donut`. */
export const PieOptions = z
  .object({
    ...NumberFields,
    ...LegendFields,
  })
  .strict();
export type PieOptions = z.infer<typeof PieOptions>;

export const TableColumn = z
  .object({
    /** The result column this entry is about. */
    name: Column,
    /** The header shown instead of the column name. */
    label: z.string().min(1).max(64).optional(),
    hidden: z.boolean().optional(),
    /** Numbers in this column are written per this format. */
    format: ValueFormat.optional(),
    ...NumberFields,
    align: z.enum(["left", "center", "right"]).optional(),
    /** In pixels. */
    width: z.number().int().min(40).max(800).optional(),
  })
  .strict();
export type TableColumn = z.infer<typeof TableColumn>;

export const TableOptions = z
  .object({
    /**
     * The listed columns come first, in this order; a result column not listed
     * follows them, as it was. A listed column the result lacks is skipped.
     */
    columns: z.array(TableColumn).max(50).optional(),
    /** The rows' order. By default the order the query returned them in. */
    sort: z
      .object({ column: Column, order: z.enum(["asc", "desc"]).optional() })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((o, ctx) => {
    const seen = new Set<string>();
    o.columns?.forEach((c, i) => {
      if (seen.has(c.name)) {
        ctx.addIssue({
          code: "custom",
          message: `column "${c.name}" is listed twice`,
          path: ["columns", i, "name"],
        });
      }
      seen.add(c.name);
    });
  });
export type TableOptions = z.infer<typeof TableOptions>;

/**
 * The editor's sections, each a set of fields some kinds share. A kind names
 * the ones it takes; anything else of its own is edited as JSON.
 */
export const OPTION_GROUPS = {
  number: ["decimals", "unit", "compact"],
  legend: ["legend"],
  axis: ["yAxis", "stacked"],
  thresholds: ["thresholds"],
  stat: ["value", "sparkline"],
  table: ["columns", "sort"],
} as const satisfies Record<string, readonly string[]>;
export type OptionGroup = keyof typeof OPTION_GROUPS;

/**
 * A kind's options as its schema reads them, or none when they do not parse.
 * The IR has validated a saved spec, but a chart is also drawn from a draft
 * and from a spec still streaming from the model, and never throws on one.
 */
export function readOptions<T extends object>(
  schema: z.ZodType<T>,
  options: unknown,
): Partial<T> {
  const parsed = schema.safeParse(options ?? {});
  return parsed.success ? parsed.data : {};
}

/** The number options among a kind's, when it was given any. */
export function numberDisplay(options: NumberDisplay): NumberDisplay | undefined {
  const { decimals, unit, compact } = options;
  return decimals === undefined && unit === undefined && compact === undefined
    ? undefined
    : { decimals, unit, compact };
}
