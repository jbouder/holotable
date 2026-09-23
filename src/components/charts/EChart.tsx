"use client";

import * as React from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";
import { useReducedMotion } from "@/components/motion-preference";

/**
 * What a caller outside the chart can ask it for.
 *
 * Deliberately one method rather than the instance: exporting a picture is a
 * read, and handing out the `ECharts` object would hand out `setOption` with
 * it — the one thing that must keep coming from `option` so the chart is never
 * recreated or fought over (invariant 11).
 */
export interface EChartHandle {
  /**
   * The chart as a PNG data URL, or null before it has initialized.
   *
   * `backgroundColor` is given rather than defaulted because the canvas is
   * transparent: exported without one, the picture is a dark theme's chart on
   * whatever the viewer's image tool puts behind it, which is usually white.
   */
  toPng(backgroundColor: string): string | null;
}

/**
 * Charts that share a crosshair, keyed by group name.
 *
 * `echarts.connect` is the documented way to do this and is deliberately NOT
 * used: it mirrors every connected action, including `brush` and `brushEnd`,
 * so one drag would make every panel on the dashboard report its own
 * selection and each would resolve the same pixel range against different
 * rows. Forwarding the pointer by hand syncs the one thing we want.
 */
const crosshairGroups = new Map<string, Set<echarts.ECharts>>();

/** What a released brush selected, as indices into the chart's category axis. */
export interface BrushSelection {
  startIndex: number;
  endIndex: number;
}

const BRUSH_OPTION = {
  xAxisIndex: 0,
  brushType: "lineX",
  brushMode: "single",
  // No toolbox: the brush is the default cursor on a time-series panel, so
  // there is no button to turn it on.
  toolbox: [],
  transformable: false,
  removeOnClick: true,
  throttleType: "debounce",
  throttleDelay: 200,
} as const;

/**
 * Thin ECharts wrapper.
 *
 * The chart instance is created ONCE and kept in a ref. Updates apply
 * `setOption` with merge semantics (notMerge=false) so incremental data over
 * the bounded rolling window merges in place — the chart is never recreated on
 * data updates. We use ECharts directly (never Recharts).
 */
export function EChart({
  option,
  className,
  ref,
  crosshairGroup,
  onBrush,
}: {
  option: EChartsOption;
  className?: string;
  /** Exposes {@link EChartHandle}; omit it and the chart is unreachable. */
  ref?: React.Ref<EChartHandle>;
  /** Charts sharing this name move their axis pointer together. */
  crosshairGroup?: string;
  /**
   * Called when a horizontal brush is released, with the selected span as
   * category-axis indices. Providing it is what turns brushing on.
   */
  onBrush?: (selection: BrushSelection) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);
  // Read through a ref so a new callback identity never re-runs the init
  // effect, which would dispose and rebuild the chart.
  const onBrushRef = React.useRef(onBrush);
  onBrushRef.current = onBrush;
  const brushing = onBrush !== undefined;
  // Reduced motion (#212) turns off ECharts' own transitions. Read through a
  // ref by the init effect so a chart rebuilt for a new crosshair group keeps
  // it, and applied as a merged option when it changes, which never recreates
  // the chart.
  const reduceMotion = useReducedMotion();
  const reduceMotionRef = React.useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;

  React.useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, "dark", {
      renderer: "canvas",
    });
    chartRef.current = chart;
    chart.setOption({ animation: !reduceMotionRef.current });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    const detachCrosshair = attachCrosshair(chart, crosshairGroup);
    const detachBrush = brushing ? attachBrush(chart, onBrushRef) : undefined;

    return () => {
      detachBrush?.();
      detachCrosshair();
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [crosshairGroup, brushing]);

  React.useEffect(() => {
    chartRef.current?.setOption({ animation: !reduceMotion }, { notMerge: false });
  }, [reduceMotion]);

  React.useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    // Merge update — no recreation.
    chart.setOption(option, { notMerge: false, lazyUpdate: true });
    if (brushing) {
      // A merged option re-reads the brush component, which drops the global
      // cursor with it, so the drag-to-select has to be re-armed after every
      // data frame or brushing would work exactly once.
      chart.dispatchAction({
        type: "takeGlobalCursor",
        key: "brush",
        brushOption: { brushType: "lineX", brushMode: "single" },
      });
    }
  }, [option, brushing]);

  React.useImperativeHandle(
    ref,
    () => ({
      toPng: (backgroundColor: string) =>
        chartRef.current?.getDataURL({
          type: "png",
          // 2 on a HiDPI screen is what makes the export match what is on it.
          pixelRatio: Math.min(2, globalThis.devicePixelRatio || 1),
          backgroundColor,
        }) ?? null,
    }),
    [],
  );

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: "100%", height: "100%" }}
    />
  );
}

/**
 * Join a crosshair group: the pointer's position on this chart is forwarded to
 * its peers as a `showTip`, and leaving the chart hides theirs.
 *
 * Forwarding is by category index, which is what makes it meaningful across
 * panels — every panel on a dashboard is looking at the same window, so the
 * nth bucket is the same instant even when the queries differ.
 */
function attachCrosshair(chart: echarts.ECharts, group: string | undefined): () => void {
  if (!group) return () => {};
  const peers = crosshairGroups.get(group) ?? new Set<echarts.ECharts>();
  crosshairGroups.set(group, peers);
  peers.add(chart);

  const others = () => [...peers].filter((peer) => peer !== chart);

  const onMove = (event: { offsetX?: number; offsetY?: number }) => {
    const index = categoryIndexAt(chart, event.offsetX, event.offsetY);
    if (index === null) return;
    for (const peer of others()) {
      peer.dispatchAction({ type: "showTip", seriesIndex: 0, dataIndex: index });
    }
  };
  const onOut = () => {
    for (const peer of others()) peer.dispatchAction({ type: "hideTip" });
  };

  const zr = chart.getZr();
  zr.on("mousemove", onMove);
  zr.on("globalout", onOut);

  return () => {
    zr.off("mousemove", onMove);
    zr.off("globalout", onOut);
    peers.delete(chart);
    if (peers.size === 0) crosshairGroups.delete(group);
  };
}

/** The category the pointer is over, or null off the grid / on a non-cartesian chart. */
function categoryIndexAt(
  chart: echarts.ECharts,
  x: number | undefined,
  y: number | undefined,
): number | null {
  if (x === undefined || y === undefined) return null;
  if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
  const converted = chart.convertFromPixel({ xAxisIndex: 0 }, [x, y]);
  const index = Array.isArray(converted) ? converted[0] : converted;
  return typeof index === "number" && Number.isFinite(index) ? Math.round(index) : null;
}

/**
 * Turn the chart's default cursor into a horizontal brush and report each
 * released selection.
 *
 * The selection is cleared immediately: the range it produced is about to
 * become the dashboard's window, and leaving a grey band over the chart that
 * now shows exactly that window reads as a second, stale selection.
 */
function attachBrush(
  chart: echarts.ECharts,
  handler: React.RefObject<((selection: BrushSelection) => void) | undefined>,
): () => void {
  chart.setOption({ brush: BRUSH_OPTION }, { notMerge: false, lazyUpdate: true });

  const onBrushEnd = (params: unknown) => {
    const range = firstCoordRange(params);
    chart.dispatchAction({ type: "brush", areas: [] });
    if (!range) return;
    const [a, b] = range;
    const startIndex = Math.floor(Math.min(a, b));
    const endIndex = Math.ceil(Math.max(a, b));
    if (endIndex <= startIndex) return;
    handler.current?.({ startIndex, endIndex });
  };

  chart.on("brushEnd", onBrushEnd);
  return () => chart.off("brushEnd", onBrushEnd);
}

/**
 * ECharts types `brushEnd`'s payload as an open-ended event object, so the one
 * field we need is read defensively rather than cast.
 */
function firstCoordRange(params: unknown): [number, number] | null {
  if (typeof params !== "object" || params === null) return null;
  const areas = (params as { areas?: unknown }).areas;
  if (!Array.isArray(areas) || areas.length === 0) return null;
  const coordRange = (areas[0] as { coordRange?: unknown }).coordRange;
  if (!Array.isArray(coordRange) || coordRange.length < 2) return null;
  const [a, b] = coordRange;
  if (typeof a !== "number" || typeof b !== "number") return null;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return [a, b];
}
