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

/**
 * A click on a datum (#373): what ECharts says was clicked, and where on the
 * screen, so a list of links can open at the point.
 */
export interface DatumClickEvent {
  seriesName?: string;
  dataIndex?: number;
  name?: string;
  /** The data item's own `id`, where a kind gives one (a treemap node's path). */
  id?: string;
  clientX: number;
  clientY: number;
}

/** What a released brush selected, as indices into the chart's category axis. */
export interface BrushSelection {
  startIndex: number;
  endIndex: number;
}

/**
 * Accessibility for every chart (#77), set once at init and kept by every
 * merged update. ECharts writes `aria.label.description` onto the container
 * as its accessible name; the decal patterns tell bar, pie and area series
 * apart without relying on color alone (WCAG 1.4.1).
 */
export const CHART_ARIA = { enabled: true, decal: { show: true } } as const;

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
  description,
  className,
  ref,
  crosshairGroup,
  onBrush,
  onDatum,
}: {
  option: EChartsOption;
  /**
   * The chart's accessible name: what it shows, in a sentence. A canvas has
   * no text of its own, so this and the data table beside it are all a screen
   * reader gets (#77).
   */
  description: string;
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
  /**
   * Called when a point, slice, cell or bar is clicked (#373). Providing it is
   * what turns clicks on; a click that ends a brush is never one.
   */
  onDatum?: (click: DatumClickEvent) => void;
}) {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const chartRef = React.useRef<echarts.ECharts | null>(null);
  // Read through a ref so a new callback identity never re-runs the init
  // effect, which would dispose and rebuild the chart.
  const onBrushRef = React.useRef(onBrush);
  onBrushRef.current = onBrush;
  const brushing = onBrush !== undefined;
  const onDatumRef = React.useRef(onDatum);
  onDatumRef.current = onDatum;
  const clicking = onDatum !== undefined;
  // Reduced motion (#212) turns off ECharts' own transitions. Read through a
  // ref by the init effect so a chart rebuilt for a new crosshair group keeps
  // it, and applied as a merged option when it changes, which never recreates
  // the chart.
  const reduceMotion = useReducedMotion();
  const reduceMotionRef = React.useRef(reduceMotion);
  reduceMotionRef.current = reduceMotion;
  const descriptionRef = React.useRef(description);
  descriptionRef.current = description;

  React.useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, "dark", {
      renderer: "canvas",
    });
    chartRef.current = chart;
    chart.setOption({
      animation: !reduceMotionRef.current,
      aria: { ...CHART_ARIA, label: { description: descriptionRef.current } },
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(containerRef.current);

    const detachCrosshair = attachCrosshair(chart, crosshairGroup);
    const brush: BrushState = { active: false, endedAt: 0 };
    const detachBrush = brushing ? attachBrush(chart, onBrushRef, brush) : undefined;
    const detachDatum = clicking ? attachDatum(chart, onDatumRef, brush) : undefined;

    return () => {
      detachDatum?.();
      detachBrush?.();
      detachCrosshair();
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [crosshairGroup, brushing, clicking]);

  React.useEffect(() => {
    chartRef.current?.setOption({ animation: !reduceMotion }, { notMerge: false });
  }, [reduceMotion]);

  // A merged option, like the motion setting: a new title never rebuilds it.
  React.useEffect(() => {
    chartRef.current?.setOption(
      { aria: { label: { description } } },
      { notMerge: false, lazyUpdate: true },
    );
  }, [description]);

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
    // An image to assistive technology, named by `description` (ECharts
    // writes the same text as `aria-label` once it initializes).
    // `data-echarts-canvas` is what the axe scans exclude
    // (e2e/support/a11y.ts): the canvas inside has nothing to read, and the
    // table beside it is scanned instead.
    <div
      ref={containerRef}
      role="img"
      aria-label={description}
      data-echarts-canvas=""
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
  state: BrushState,
): () => void {
  chart.setOption({ brush: BRUSH_OPTION }, { notMerge: false, lazyUpdate: true });

  // A drag in progress: the click that may end it is not a datum click.
  const onBrushing = (params: unknown) => {
    if (firstCoordRange(params)) state.active = true;
  };
  const onBrushEnd = (params: unknown) => {
    const range = firstCoordRange(params);
    state.active = false;
    if (range) state.endedAt = Date.now();
    chart.dispatchAction({ type: "brush", areas: [] });
    if (!range) return;
    const [a, b] = range;
    const startIndex = Math.floor(Math.min(a, b));
    const endIndex = Math.ceil(Math.max(a, b));
    if (endIndex <= startIndex) return;
    handler.current?.({ startIndex, endIndex });
  };

  chart.on("brush", onBrushing);
  chart.on("brushEnd", onBrushEnd);
  return () => {
    chart.off("brush", onBrushing);
    chart.off("brushEnd", onBrushEnd);
  };
}

/** Whether a click is part of a brush: during the drag, or the release that ended it. */
export function isBrushClick(brush: BrushState, now: number): boolean {
  return brush.active || now - brush.endedAt < BRUSH_CLICK_GRACE_MS;
}

/** Whether a brush is being dragged, and when the last one that selected anything ended. */
export interface BrushState {
  active: boolean;
  endedAt: number;
}

/**
 * How long after a brush ends a click is still part of it. ECharts reports
 * the release of a drag as a click on whatever is under the pointer, after
 * the debounced `brushEnd`, so the two are told apart by time.
 */
const BRUSH_CLICK_GRACE_MS = 400;

/** Report clicks on the chart's data, except the one that ends a brush (#373). */
function attachDatum(
  chart: echarts.ECharts,
  handler: React.RefObject<((click: DatumClickEvent) => void) | undefined>,
  brush: BrushState,
): () => void {
  const onClick = (params: unknown) => {
    if (isBrushClick(brush, Date.now())) return;
    const click = datumClick(params);
    if (click) handler.current?.(click);
  };
  chart.on("click", onClick);
  return () => chart.off("click", onClick);
}

/** The fields of an ECharts click a datum needs, read defensively. */
export function datumClick(params: unknown): DatumClickEvent | null {
  if (typeof params !== "object" || params === null) return null;
  const p = params as {
    seriesName?: unknown;
    dataIndex?: unknown;
    name?: unknown;
    data?: unknown;
    event?: { event?: { clientX?: unknown; clientY?: unknown } };
  };
  const id =
    typeof p.data === "object" && p.data !== null
      ? (p.data as { id?: unknown }).id
      : undefined;
  const native = p.event?.event;
  const clientX = typeof native?.clientX === "number" ? native.clientX : 0;
  const clientY = typeof native?.clientY === "number" ? native.clientY : 0;
  return {
    seriesName: typeof p.seriesName === "string" ? p.seriesName : undefined,
    dataIndex: typeof p.dataIndex === "number" ? p.dataIndex : undefined,
    name: typeof p.name === "string" ? p.name : undefined,
    ...(typeof id === "string" ? { id } : {}),
    clientX,
    clientY,
  };
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
