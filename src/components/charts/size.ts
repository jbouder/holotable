import { formatValue } from "@/lib/format";
import type { ValueFormat } from "@/lib/ir";
import type { NumberDisplay } from "@/lib/panels/presentation";

/**
 * How big a chart is drawn, and what fits in it (#643).
 *
 * ECharts draws text at fixed pixel sizes and a builder is not told how big
 * it is drawn, so on a small panel ticks, labels and values collide while the
 * plot shrinks around them. `EChart` measures its container and hands the
 * builder a stepped {@link ChartSize} on `ChartContext.size`; the rules below
 * turn that into what a kind draws. Each is pure, and each answers with
 * today's chart when there is no size (a test, an export before layout), so
 * a builder that ignores `size` is unchanged.
 *
 * A size step rebuilds the option and merges it into the same chart; nothing
 * here is part of a chart's shape key (invariant 11). So every field a rule
 * sets is set in both of its answers (`show: false`, never left out): a merge
 * keeps a field the new option no longer mentions.
 */

/** A chart's drawn size in CSS pixels, stepped by {@link SIZE_STEP}. */
export interface ChartSize {
  width: number;
  height: number;
}

/**
 * The size steps a chart is rebuilt at. Fine enough that a rule's threshold
 * is met within a step of where it is, coarse enough that a drag rebuilds a
 * handful of times rather than every frame.
 */
export const SIZE_STEP = 20;

/** How long a size has to hold before the chart is rebuilt for it. */
export const SIZE_SETTLE_MS = 120;

/**
 * A measured box as the step it falls in, or undefined when it is not drawn
 * (zero in either direction: a hidden tab, a collapsed row), when there is
 * nothing to fit.
 */
export function sizeStep(width: number, height: number): ChartSize | undefined {
  if (!(width > 0) || !(height > 0)) return undefined;
  const step = (px: number) =>
    Math.max(SIZE_STEP, Math.floor(px / SIZE_STEP) * SIZE_STEP);
  return { width: step(width), height: step(height) };
}

/** Whether two steps are the same, so the chart is not rebuilt for nothing. */
export function sameSize(a: ChartSize | undefined, b: ChartSize | undefined): boolean {
  return a?.width === b?.width && a?.height === b?.height;
}

/** How many ticks a value axis draws, and how it writes them. */
export interface AxisDensity {
  /** `splitNumber` for a vertical value axis. */
  y: number;
  /** `splitNumber` for a horizontal value axis. */
  x: number;
  /** Large numbers as `60M` rather than `60,000,000`: the axis is narrow. */
  compact: boolean;
}

/** ECharts' own tick count, which a chart with room keeps. */
const MOST_TICKS = 5;
const FEWEST_TICKS = 2;
/** Height a y tick needs: its line of text and a gap, so labels never touch. */
const Y_TICK_PX = 30;
/** Width an x tick needs: a formatted value like `1.5 GB` and a gap. */
const X_TICK_PX = 70;
/** The plot's share of the box: the box less its axis labels and legend. */
const Y_CHROME_PX = 40;
const X_CHROME_PX = 60;
/** Below this width a value axis writes large numbers compactly. */
export const COMPACT_BELOW_PX = 480;

/**
 * How dense a value axis can be at this size: a tick per line of text the
 * plot has room for, between two and ECharts' five. Every axis label also
 * hides the ones that would still overlap (`tickLabel` in `style.ts`), so a
 * tick the hint lets through never sits on another.
 */
export function axisDensity(size: ChartSize | undefined): AxisDensity {
  if (!size) return { y: MOST_TICKS, x: MOST_TICKS, compact: false };
  const fit = (room: number, per: number) =>
    Math.min(MOST_TICKS, Math.max(FEWEST_TICKS, Math.floor(room / per)));
  return {
    y: fit(size.height - Y_CHROME_PX, Y_TICK_PX),
    x: fit(size.width - X_CHROME_PX, X_TICK_PX),
    compact: size.width < COMPACT_BELOW_PX,
  };
}

/**
 * Which decades a log axis labels at this size: every `n`th, so each label
 * has a line of its own. ECharts draws a log axis a decade a tick whatever
 * `splitNumber` says (fewer turns 1 to 100,000 into 1 to 10,000,000,000), and
 * six decades in a short plot touch without overlapping, so nothing hides
 * them. `low` and `high` are the data's smallest and largest positive values.
 */
export function logLabelStep(
  size: ChartSize | undefined,
  low: number,
  high: number,
): number {
  if (!size || !(low > 0) || !(high > 0)) return 1;
  const decades = Math.ceil(Math.log10(high)) - Math.floor(Math.log10(low)) + 1;
  const room = Math.max(1, size.height - Y_CHROME_PX) / Math.max(1, decades);
  return Math.max(1, Math.ceil(Y_TICK_PX / room));
}

/**
 * A log axis's tick formatter that writes every `step`th decade and leaves
 * the rest blank (their gridlines stay). Undefined at a step of one.
 */
export function logTicks(
  step: number,
  write: ((value: unknown) => string) | undefined,
): ((value: number) => string) | undefined {
  if (step <= 1) return write;
  return (v) => {
    const decade = Math.round(Math.log10(v));
    if (decade % step !== 0) return "";
    return write ? write(v) : formatValue(v);
  };
}

/**
 * How a value axis writes its ticks. A wide axis writes them as it did before
 * #643: through the panel's number options when it has them, ECharts' own
 * otherwise (undefined). A narrow one writes a number of four digits or more
 * compactly (`60M`), and bytes always in their unit, so the label column
 * stays narrow and a unit is never dropped. Only large numbers are made
 * compact because compact notation keeps one fraction digit, which would
 * write the ticks 0.25, 0.5 and 0.75 as 0.3, 0.5 and 0.8. A panel's
 * `compact: false` wins.
 */
export function axisNumber(
  format: ValueFormat | undefined,
  display: NumberDisplay | undefined,
  density: AxisDensity,
): ((value: unknown) => string) | undefined {
  if (!density.compact) {
    return display ? (v) => formatValue(v, format, display) : undefined;
  }
  return (v) => {
    const n = typeof v === "number" ? v : Number(v);
    const large = Math.abs(n) >= 1000;
    if (display) {
      return formatValue(
        v,
        format,
        // The panel's decimals are for its readings; at `0` a compact tick
        // would write 1.5K and 2K both as `2K`.
        large && display.compact !== false
          ? { ...display, compact: true, decimals: undefined }
          : display,
      );
    }
    if (format === "bytes") return formatValue(v, format);
    return large ? formatValue(v, undefined, { compact: true }) : String(v);
  };
}

/** Whether a set of labels fits, and how much room each one has. */
export interface LabelBudget {
  /**
   * Draw the labels. When false, a kind draws them on hover and focus only:
   * the tooltip and the screen-reader table still carry every one, and none
   * is drawn half on top of another.
   */
  show: boolean;
  /** Pixels each label has along the direction they are stacked in. */
  room: number;
}

/**
 * Whether `count` labels stacked along one direction of the chart fit, each
 * needing `need` pixels there (a line of text and its gap for a stack of
 * rows; the widest label for a row of columns). `chrome` is what the chart
 * spends along that direction before its labels (axis labels, padding). No
 * size, or nothing to label, always fits.
 *
 * Shared by the kinds that label rows or nodes: a timeline's lanes, a
 * graph's layers, a sankey's nodes, a bar gauge's rows, and a pie's slices.
 */
export function labelBudget(
  size: ChartSize | undefined,
  count: number,
  {
    along = "height",
    need,
    chrome = 0,
  }: { along?: "width" | "height"; need: number; chrome?: number },
): LabelBudget {
  if (!size || count <= 0) return { show: true, room: Number.POSITIVE_INFINITY };
  const room = Math.max(0, size[along] - chrome) / count;
  return { show: room >= need, room };
}

/**
 * Roughly how wide a line of chart text is drawn, in pixels: a canvas cannot
 * be asked before it draws, and a rule only needs to know whether text fits,
 * so this errs wide (the page's face is a wide one).
 */
export function textWidth(text: string, textPx: number): number {
  return Math.ceil(text.length * textPx * 0.62);
}

/** A legend entry's swatch, the gap after it, and the gap to the next entry. */
const LEGEND_ENTRY_PX = 12 + 5 + 10;
/** ECharts' padding on each side of a legend. */
const LEGEND_PADDING_PX = 5;

/**
 * How many lines a horizontal legend of `names` wraps to across `width`:
 * ECharts wraps a plain legend rather than cutting it, and each extra line
 * comes down over the plot unless the plot makes room for it.
 */
export function legendRows(
  width: number,
  names: readonly string[],
  textPx: number,
): number {
  const room = Math.max(1, width - 2 * LEGEND_PADDING_PX);
  let rows = names.length > 0 ? 1 : 0;
  let used = 0;
  for (const name of names) {
    const entry = LEGEND_ENTRY_PX + textWidth(name, textPx);
    if (used > 0 && used + entry > room) {
      rows++;
      used = 0;
    }
    used += entry;
  }
  return rows;
}

/** How a graph's or a flow's node labels are drawn at a size (#643). */
export interface NodeLabels {
  /** Draw them; when false they show on hover and focus only. */
  show: boolean;
  /** With the node's value after its name; when false, the name alone. */
  values: boolean;
  /** A size under the label size, the smallest the chart writes. */
  small: boolean;
}

/** A pinned label's padding across, and the gap it keeps to the next. */
const NODE_LABEL_PAD_PX = 14;

/**
 * Whether node labels fit a layout of `across` columns and `down` rows
 * (a graph's layers and the most nodes in one, a flow's stages and the most
 * nodes in one), each label needing its widest text across and a line down.
 * Tried in order: full labels, full labels a size smaller, names alone, names
 * a size smaller; failing all four, no labels, never half-drawn ones. `chrome`
 * is what the chart spends around the layout in each direction.
 *
 * #649 reads it to decide when a graph's block nodes do not fit.
 */
export function nodeLabels(
  size: ChartSize | undefined,
  {
    across,
    down,
    widest,
    widestName,
    textPx,
    line = textPx + 8,
    chrome = { width: 0, height: 0 },
  }: {
    across: number;
    down: number;
    /** The longest label as drawn with its value. */
    widest: string;
    /** The longest label as drawn without its value. */
    widestName: string;
    textPx: number;
    /** The height a row needs: the label's line, and the node's own symbol. */
    line?: number;
    chrome?: { width: number; height: number };
  },
): NodeLabels {
  if (!size) return { show: true, values: true, small: false };
  const fits = (label: string, px: number) =>
    labelBudget(size, across, {
      along: "width",
      need: textWidth(label, px) + NODE_LABEL_PAD_PX,
      chrome: chrome.width,
    }).show &&
    labelBudget(size, down, {
      along: "height",
      need: line - (textPx - px),
      chrome: chrome.height,
    }).show;
  for (const [values, label] of [
    [true, widest],
    [false, widestName],
  ] as const) {
    if (fits(label, textPx)) return { show: true, values, small: false };
    if (fits(label, textPx - 1)) return { show: true, values, small: true };
  }
  return { show: false, values: false, small: true };
}
