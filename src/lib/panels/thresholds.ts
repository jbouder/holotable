import { z } from "zod";
import { ColorToken } from "@/lib/panels/colors";

/**
 * Threshold steps: `{ value, color }` in ascending order. A value takes the
 * color of the last step at or below it, and a value below every step takes
 * none (the kind's own default).
 *
 * Shared rather than gauge-only, because the stat and series colors of #115
 * are meant to follow the same rule.
 */
export const ThresholdStep = z
  .object({
    value: z.number(),
    color: ColorToken,
  })
  .strict();
export type ThresholdStep = z.infer<typeof ThresholdStep>;

export const Thresholds = z
  .array(ThresholdStep)
  .max(10)
  .superRefine((steps, ctx) => {
    for (let i = 1; i < steps.length; i++) {
      if (steps[i].value <= steps[i - 1].value) {
        ctx.addIssue({
          code: "custom",
          message: "threshold steps must be in strictly ascending order of value",
          path: [i, "value"],
        });
      }
    }
  });

/** The color a value falls in, or undefined below the first step. */
export function thresholdColor(
  steps: readonly ThresholdStep[] | undefined,
  value: number,
): ColorToken | undefined {
  let color: ColorToken | undefined;
  for (const step of steps ?? []) {
    if (value >= step.value) color = step.color;
    else break;
  }
  return color;
}
