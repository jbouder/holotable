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

/** The silhouette a kind's body shows while its first rows are on their way. */
export type PanelSkeletonShape = "chart" | "radial" | "stat" | "table";

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
   * The x-axis is the panel's time field laid out left to right, so dragging
   * across the chart names a stretch of time (#75).
   */
  readonly timeBrush: boolean;
  /** What the panel looks like while it loads (#72). */
  readonly skeleton: PanelSkeletonShape;
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
