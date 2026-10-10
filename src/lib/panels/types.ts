/**
 * A panel kind, as the shared half of the panel registry sees it (#61).
 *
 * Everything about a kind that the server, the model's prompt and the IR need
 * lives here, in plain data: its name, what it is for, and which of the
 * platform's features it takes part in. How it is drawn is the other half,
 * in `src/components/panels/`, because that half is React and this one is
 * imported by `src/lib/ir.ts`, which the server and the generation prompt
 * also read.
 *
 * This module and everything under `src/lib/panels/` must not import
 * `src/lib/ir.ts`: the IR is built from the registry, not the other way round.
 */

import type { z } from "zod";
import type { OptionGroup } from "@/lib/panels/presentation";

/** The silhouette a kind's body shows while its first rows are on their way. */
export type PanelSkeletonShape =
  | "chart"
  | "radial"
  | "stat"
  | "table"
  | "lanes"
  | "grid"
  | "text";

export interface PanelKind<K extends string = string> {
  /** The value of `panel.viz`. Stored in every saved spec, so never renamed. */
  readonly kind: K;
  /**
   * One line for a person: what the kind shows and what result shape it
   * expects. The visualization reference in the docs is generated from it.
   */
  readonly summary: string;
  /**
   * One line for the model: when to choose this kind, and what the query has
   * to return for it. The generation prompt's viz list is built from these.
   */
  readonly promptHint: string;
  /**
   * Drawn by ECharts on a canvas. Decides whether the panel can be exported as
   * a PNG, and whether the explore page plots it.
   */
  readonly canvas: boolean;
  /**
   * Draws its own image rather than an ECharts chart (a custom visual, #405):
   * it can be exported as a PNG, but explore does not plot it.
   */
  readonly image?: boolean;
  /**
   * The x-axis is the panel's time field laid out left to right, so dragging
   * across the chart names a stretch of time (#75).
   */
  readonly timeBrush: boolean;
  /** What the panel looks like while it loads (#72). */
  readonly skeleton: PanelSkeletonShape;
  /**
   * Whether the panel runs a query. `"none"` is a panel with nothing to
   * execute (#202): it must not carry one, and every consumer of
   * `panel.query` skips it.
   */
  readonly query: "required" | "none";
  /**
   * The hint for a panel against a Prometheus source (#387), where it differs
   * from `promptHint`: PromQL has no `timeField`, and its rows are wide (one
   * column per series), so the shape a kind asks for is said differently.
   */
  readonly promqlHint?: string;
  /** The kind cannot be drawn without `query.timeField` (#201). */
  readonly requiresTimeField?: boolean;
  /**
   * The kind's own presentation options, `panel.options`, as a strict object
   * schema. A kind without one takes no options. The IR validates a panel's
   * options against its kind's schema, so a gauge's options on a pie are
   * refused. Every field should be optional unless the kind cannot be drawn
   * without it: a missing `options` is parsed as `{}`.
   */
  readonly options?: z.ZodType<Record<string, unknown>>;
  /**
   * The shared presentation groups among those options (#115), in the order
   * the editor shows them. A field in none of them is edited as JSON.
   */
  readonly optionGroups?: readonly OptionGroup[];
  /**
   * A check of a panel's options beyond their schema: an error message, or
   * undefined when the options pass. The server runs it wherever a dashboard
   * is accepted (`resolveAndValidateDashboard`), and the editor runs it as the
   * options are typed, so it must work in both: a custom visual's spec is
   * compiled here (#405), importing the compiler dynamically. The IR never
   * calls it.
   */
  readonly check?: (options: unknown) => Promise<string | undefined>;
  /**
   * The options a panel switched to this kind starts with, when `{}` would not
   * do (a text panel needs content). Given the panel's title.
   */
  readonly starterOptions?: (title: string) => Record<string, unknown>;
}

/**
 * Declare a kind. The `const` parameter keeps `kind` as its literal, which is
 * what lets the registry list become the IR's enum.
 */
export function definePanelKind<const K extends string>(
  spec: PanelKind<K>,
): PanelKind<K> {
  return spec;
}
