import type { EChartsOption } from "echarts";
import { type ChartTheme, INK, soften, withAlpha } from "@/lib/color/chart-theme";

/**
 * The one style every chart kind starts from (#647).
 *
 * Before this, each kind set its own text sizes, gridlines, line widths and
 * tooltip corners, and none set a font, so a chart was drawn in the canvas's
 * generic sans-serif beside a page set in the app's face. Everything a kind
 * needs that is not its own data shape is here: the page's font and the
 * chart type scale, quiet gridlines with no axis lines, the series line
 * width, an area fill, bar and block corners from the page's radius, labels
 * pinned to nodes, and the tooltip on the page's raised surface.
 *
 * A kind spreads `shared(theme)` first and `axis(theme)` into each value
 * axis, then says only what is its own. `test/chart-theme.test.ts` holds
 * every registered kind to the font and the tooltip, and holds every other
 * chart module free of its own `borderRadius`, `fontFamily` and `fontSize`,
 * so a new kind cannot drift.
 *
 * Nothing here is a constant of the look: every size, width, opacity and
 * color is read off the page through `ChartTheme`, so the style follows the
 * palette and the scheme.
 */

/** Text as the page writes it: the page's font, a size, the chart's text color. */
export function text(
  theme: ChartTheme,
  size: number = theme.type.axis,
  color = theme.text,
) {
  return { fontFamily: theme.font, fontSize: size, color };
}

/**
 * A tooltip on the page's raised surface with the page's corners, written in
 * the page's font. Every kind's tooltip spreads this and adds its trigger and
 * formatter.
 */
export function tooltip(theme: ChartTheme) {
  return {
    borderRadius: theme.radius,
    backgroundColor: theme.raised,
    borderColor: theme.line,
    borderWidth: 1,
    padding: [6, 10],
    textStyle: text(theme, theme.type.tooltip, theme.foreground),
    extraCssText: `box-shadow: 0 4px 16px ${withAlpha(INK.dark, 0.18)};`,
  };
}

/**
 * What every chart starts from, whatever its kind: the page's font on all its
 * text, a transparent background, the series colors, and the tooltip. Spread
 * first, so a kind's own fields win.
 */
export function shared(theme: ChartTheme): EChartsOption {
  return {
    backgroundColor: "transparent",
    textStyle: { fontFamily: theme.font, fontSize: theme.type.axis },
    color: [...theme.series],
    tooltip: tooltip(theme),
  };
}

/**
 * An axis's tick labels: the axis text, and a label that would overlap the
 * one before it is not drawn (#643), on every axis, so a small panel thins
 * its ticks rather than stacking them. `formatter` is always set, undefined
 * for ECharts' own: a size step merges into the chart, and a merge would keep
 * a formatter an earlier step set if this one left the key out.
 */
export function tickLabel<F = undefined>(theme: ChartTheme, formatter?: F) {
  return { ...text(theme), hideOverlap: true, formatter };
}

/** A value axis: a faint gridline per step, no axis line, no ticks. */
export function axis(theme: ChartTheme) {
  return {
    axisLine: { show: false },
    axisTick: { show: false },
    axisLabel: tickLabel(theme),
    splitLine: { show: true, lineStyle: { color: theme.grid, width: 1 } },
  };
}

/** A category axis: as a value axis, but only the value axis draws gridlines. */
export function categoryAxis(theme: ChartTheme) {
  return { ...axis(theme), splitLine: { show: false } };
}

/** The legend's entries: the page's text with small swatches, rounded only where the page is. */
export function legend(theme: ChartTheme) {
  return {
    textStyle: text(theme),
    icon: theme.radius > 0 ? "roundRect" : "rect",
    itemWidth: 12,
    itemHeight: 8,
  };
}

/**
 * A series line. In a stack it also draws a 1px line of surface just above
 * itself, as a shadow, so it parts its band from the one above without a
 * strong outline; `stackOrder` then draws a lower band over the one above it,
 * so that parting and the line sit on top.
 */
export function seriesLine(theme: ChartTheme, stacked = false) {
  return stacked
    ? {
        width: theme.lineWidth,
        shadowColor: theme.background,
        shadowBlur: 0,
        shadowOffsetY: -1,
      }
    : { width: theme.lineWidth };
}

/**
 * The drawing order of the `index`th of `count` stacked series: the first,
 * at the bottom, last. A band's top edge is its own line, which the band
 * drawn after it would otherwise cover.
 */
export function stackOrder(index: number, count: number) {
  return { z: 2 + count - index };
}

/**
 * An area's fill. Alone, it fades from its color at the line to nothing at
 * the axis. In a stack, a band's thickness is the data, so it is near solid
 * and softened like any large area; a fade would not fit, since a band's
 * bottom is the band below. `color` is `undefined` when a threshold's visual
 * map owns it: a map cannot fill a gradient, so an unstacked area is then a
 * flat, low opacity.
 *
 * The gradient is a plain object, not `graphic.LinearGradient`: only
 * `echarts.ts` imports ECharts at runtime (#488).
 */
export function areaFill(theme: ChartTheme, color: string | undefined, stacked: boolean) {
  if (stacked) {
    return color === undefined
      ? { opacity: theme.area.stacked }
      : { color: soften(theme, color), opacity: theme.area.stacked };
  }
  if (color === undefined) return { opacity: theme.area.flat };
  return {
    color: {
      type: "linear" as const,
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: withAlpha(color, theme.area.fade) },
        { offset: 1, color: withAlpha(color, 0) },
      ],
    },
  };
}

/** A bar's corners: the page's radius, halved, on the end that grows. */
export function barCorners(theme: ChartTheme, horizontal = false) {
  const r = Math.round(theme.radius / 2);
  if (r === 0) return {};
  return { borderRadius: horizontal ? [0, r, r, 0] : [r, r, 0, 0] };
}

/**
 * A block (a slice, a cell, a node) parted from its neighbors by a hair of
 * surface rather than a dark edge, with the page's corners up to `cap`.
 */
export function block(theme: ChartTheme, { edge = 1, cap = 4 } = {}) {
  return {
    borderColor: theme.background,
    borderWidth: edge,
    borderRadius: Math.min(theme.radius, cap),
  };
}

/**
 * A timeline span's corner radius, as a custom series' rect takes it: the
 * page's, capped at 4 and at half the span's height, on a span wide enough
 * to carry it. A history cell stays square, or a lane reads as a chain of
 * pills.
 */
export function spanCorner(theme: ChartTheme, shape: { width: number; height: number }) {
  return shape.width >= 48 ? Math.min(theme.radius, 4, shape.height / 2) : 0;
}

/**
 * A label written on a block: a treemap node's, a timeline span's. `small`
 * writes it a size under, the smallest the chart scale goes, where a small
 * panel has room for a label only at that size (#643).
 */
export function blockLabel(theme: ChartTheme, small = false) {
  return { fontFamily: theme.font, fontSize: theme.type.label - (small ? 1 : 0) };
}

/**
 * A block's label of two weights (#657): its name at the label size, and its
 * value on the line under it as the `v` rich style, in the regular weight.
 * Each line is `lineHeight` tall, the label's size and a gap, which is what a
 * kind measures to know whether the label fits its block.
 */
export function blockValueLabel(theme: ChartTheme) {
  const px = theme.type.label;
  return {
    fontFamily: theme.font,
    fontSize: px,
    fontWeight: 600,
    lineHeight: blockLine(theme),
    rich: {
      v: {
        fontFamily: theme.font,
        fontSize: px,
        fontWeight: 400,
        lineHeight: blockLine(theme),
      },
    },
  };
}

/** One line of a {@link blockValueLabel}, in pixels. */
export function blockLine(theme: ChartTheme): number {
  return theme.type.label + 4;
}

/**
 * A group's header written on the group (#657): its name in the foreground,
 * and its total, as the `t` rich style, in the chart's muted text, centered
 * in a band `height` tall.
 */
export function headerLabel(theme: ChartTheme, height: number) {
  return {
    fontFamily: theme.font,
    fontSize: theme.type.label,
    fontWeight: 600,
    lineHeight: height,
    color: theme.foreground,
    rich: {
      t: {
        fontFamily: theme.font,
        fontSize: theme.type.label,
        fontWeight: 400,
        lineHeight: height,
        color: theme.text,
      },
    },
  };
}

/** A label pinned to a node: its own small box with the page's corners. */
export function pinnedLabel(theme: ChartTheme, small = false) {
  return {
    ...blockLabel(theme, small),
    padding: [2, 5],
    borderRadius: Math.min(theme.radius, 4),
  };
}

/** An edge's label, a size under a node's, on the surface. */
export function edgeLabel(theme: ChartTheme) {
  return {
    fontFamily: theme.font,
    fontSize: theme.type.label - 1,
    color: theme.text,
    backgroundColor: theme.background,
    padding: [1, 3],
  };
}

/**
 * The one value a gauge writes large: at the type scale's value size, or at
 * `px` where the gauge scales it to its ring (#643), which `gaugeScale` holds
 * between the label size and twice the value size.
 */
export function valueText(theme: ChartTheme, px: number = theme.type.value) {
  return {
    fontFamily: theme.font,
    fontSize: px,
    fontWeight: 600,
    color: theme.foreground,
  };
}
