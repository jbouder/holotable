"use client";

import * as React from "react";
import * as echarts from "@/components/charts/echarts";
import type { EChartsOption } from "echarts";
import { useChartPatterns } from "@/components/chart-patterns";
import { useReducedMotion } from "@/components/motion-preference";
import {
  type ChartSize,
  SIZE_SETTLE_MS,
  sameSize,
  sizeStep,
} from "@/components/charts/size";

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
   * A custom visual (#405) draws asynchronously, so it may answer later.
   */
  toPng(backgroundColor: string): string | null | Promise<string | null>;
  /**
   * Zoom or pan a chart that roams (#682), as a drag, a pinch or Ctrl and the
   * wheel would: the buttons and keys beside it, for whoever cannot drag.
   * Nothing on a chart whose option does not roam ({@link roamKind}).
   */
  roam?(step: RoamStep): void;
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
 * as its accessible name. The decal patterns, which tell bar, pie and area
 * series apart without relying on color alone (WCAG 1.4.1), are the person's
 * `chartPatterns` preference: off unless they turn them on.
 */
export function chartAria(patterns: boolean) {
  return { enabled: true, decal: { show: patterns } } as const;
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
  description,
  className,
  ref,
  crosshairGroup,
  onBrush,
  onDatum,
  onSize,
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
  /**
   * Called with the chart's size whenever it crosses a step (#643): at once
   * when it is first laid out, then once a drag has settled. The caller
   * rebuilds `option` for it, which merges into this same chart.
   */
  onSize?: (size: ChartSize | undefined) => void;
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
  const onSizeRef = React.useRef(onSize);
  onSizeRef.current = onSize;
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
  // The patterns preference, read like reduced motion: at init through a ref,
  // and merged in when it changes, which never recreates the chart.
  const patterns = useChartPatterns();
  const patternsRef = React.useRef(patterns);
  patternsRef.current = patterns;
  // The branches a reader opened or closed on a tree (#623), by node id, so a
  // poll's merged option keeps them as they were left. A remount forgets them.
  const treeStateRef = React.useRef<TreeState>(new Map());

  React.useEffect(() => {
    if (!containerRef.current) return;
    const chart = echarts.init(containerRef.current, "dark", {
      renderer: "canvas",
    });
    chartRef.current = chart;
    chart.setOption({
      animation: !reduceMotionRef.current,
      aria: {
        ...chartAria(patternsRef.current),
        label: { description: descriptionRef.current },
      },
    });

    // The canvas follows every frame of a resize; the option is rebuilt only
    // when the size crosses a step and holds there (#643), so a drag does not
    // rebuild it every frame. The first size is reported at once: the chart's
    // first option should already fit.
    const container = containerRef.current;
    let reported: ChartSize | undefined;
    let first = true;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const size = sizeStep(container.clientWidth, container.clientHeight);
      if (!first && sameSize(size, reported)) return;
      first = false;
      reported = size;
      onSizeRef.current?.(size);
    };
    const observer = new ResizeObserver(() => {
      chart.resize();
      if (first) return report();
      clearTimeout(settle);
      settle = setTimeout(report, SIZE_SETTLE_MS);
    });
    observer.observe(container);

    const detachCrosshair = attachCrosshair(chart, crosshairGroup);
    const brush: BrushState = { active: false, endedAt: 0 };
    const detachBrush = brushing ? attachBrush(chart, onBrushRef, brush) : undefined;
    const detachDatum = clicking ? attachDatum(chart, onDatumRef, brush) : undefined;
    const detachTree = attachTreeToggle(chart, treeStateRef.current);
    const detachZoom = attachCtrlZoom(chart);

    return () => {
      detachZoom();
      detachTree();
      detachDatum?.();
      detachBrush?.();
      detachCrosshair();
      clearTimeout(settle);
      observer.disconnect();
      chart.dispose();
      chartRef.current = null;
    };
  }, [crosshairGroup, brushing, clicking]);

  React.useEffect(() => {
    chartRef.current?.setOption({ animation: !reduceMotion }, { notMerge: false });
  }, [reduceMotion]);

  React.useEffect(() => {
    chartRef.current?.setOption({ aria: chartAria(patterns) }, { notMerge: false });
  }, [patterns]);

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
    chart.setOption(withTreeState(option, treeStateRef.current), {
      notMerge: false,
      lazyUpdate: true,
    });
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
      roam: (step: RoamStep) => {
        if (chartRef.current) roamChart(chartRef.current, step);
      },
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

/**
 * The category the pointer is over, or null off the grid / on a
 * non-cartesian chart. Exported for unit testing.
 *
 * Converted through the grid, not the x axis: an axis finder takes one
 * coordinate and answers `NaN` for a point, which is how the crosshair never
 * reached its peers (#517).
 */
export function categoryIndexAt(
  chart: Pick<echarts.ECharts, "containPixel" | "convertFromPixel">,
  x: number | undefined,
  y: number | undefined,
): number | null {
  if (x === undefined || y === undefined) return null;
  if (!chart.containPixel({ gridIndex: 0 }, [x, y])) return null;
  const converted = chart.convertFromPixel({ gridIndex: 0 }, [x, y]);
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
    // A tree node's symbol opens and closes its branch; only its label is a datum.
    if (treeClickPart(params) === "toggle") return;
    const click = datumClick(params);
    if (!click) return;
    // A sampled series (#491) numbers its points among the ones it kept; the
    // datum is read off the panel's rows, so the click names the raw index.
    const raw = rawDataIndex(chart, params);
    handler.current?.(raw === undefined ? click : { ...click, dataIndex: raw });
  };
  chart.on("click", onClick);
  return () => chart.off("click", onClick);
}

/**
 * The clicked point's index in the series' own data, which differs from the
 * event's `dataIndex` when ECharts sampled the series. Undefined when it
 * cannot be read, and the event's index stands.
 */
function rawDataIndex(chart: echarts.ECharts, params: unknown): number | undefined {
  const p = params as { seriesIndex?: unknown; dataIndex?: unknown } | null;
  if (typeof p?.seriesIndex !== "number" || typeof p.dataIndex !== "number") {
    return undefined;
  }
  try {
    const model = (
      chart as unknown as {
        getModel(): {
          getSeriesByIndex(
            i: number,
          ): { getData(): { getRawIndex(i: number): number } } | undefined;
        };
      }
    ).getModel();
    const raw = model.getSeriesByIndex(p.seriesIndex)?.getData().getRawIndex(p.dataIndex);
    return typeof raw === "number" && raw >= 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Whether each tree node a reader toggled is now collapsed, by its id (#623). */
export type TreeState = Map<string, boolean>;

/**
 * Which part of a tree node a click landed on (#623): its label is a datum
 * (#373), anything else on it (the symbol) opens or closes its branch. Null
 * for a click on any other series. The label is a text element, or a part of
 * one (its background, a span), which is how the two are told apart.
 */
export function treeClickPart(params: unknown): "toggle" | "datum" | null {
  if (typeof params !== "object" || params === null) return null;
  const p = params as { seriesType?: unknown; event?: { target?: unknown } };
  if (p.seriesType !== "tree") return null;
  let el = p.event?.target as { type?: unknown; parent?: unknown } | undefined;
  for (let depth = 0; el && depth < 4; depth++) {
    if (el.type === "text") return "datum";
    el = el.parent as typeof el;
  }
  return "toggle";
}

/**
 * Open or close a tree node's branch when its symbol is clicked, and remember
 * it. The series turns ECharts' own toggle off (it fires on the label too),
 * so this is the only one.
 */
function attachTreeToggle(chart: echarts.ECharts, state: TreeState): () => void {
  const onClick = (params: unknown) => {
    if (treeClickPart(params) !== "toggle") return;
    const p = params as {
      seriesIndex?: number;
      dataIndex?: number;
      collapsed?: boolean;
      data?: { id?: unknown; children?: unknown };
    };
    if (typeof p.data?.id !== "string" || !Array.isArray(p.data.children)) return;
    state.set(p.data.id, !p.collapsed);
    chart.dispatchAction({
      type: "treeExpandAndCollapse",
      seriesIndex: p.seriesIndex,
      dataIndex: p.dataIndex,
    });
  };
  chart.on("click", onClick);
  return () => chart.off("click", onClick);
}

/**
 * The option with every toggled tree node as the reader left it: a merged
 * update re-reads `collapsed` from the data, which would otherwise undo it.
 */
export function withTreeState(option: EChartsOption, state: TreeState): EChartsOption {
  if (state.size === 0 || !Array.isArray(option.series)) return option;
  const visit = (item: unknown): unknown => {
    if (typeof item !== "object" || item === null) return item;
    const node = item as { id?: unknown; children?: unknown };
    const collapsed = typeof node.id === "string" ? state.get(node.id) : undefined;
    return {
      ...node,
      ...(collapsed !== undefined ? { collapsed } : {}),
      ...(Array.isArray(node.children) ? { children: node.children.map(visit) } : {}),
    };
  };
  return {
    ...option,
    series: option.series.map((series) =>
      (series as { type?: unknown }).type === "tree" &&
      Array.isArray((series as { data?: unknown }).data)
        ? { ...series, data: (series as { data: unknown[] }).data.map(visit) }
        : series,
    ),
  } as EChartsOption;
}

/**
 * The series a Ctrl-wheel zooms (#625): a force graph's, which pans with a
 * drag (`roam: "move"`) but would take the page's scroll if ECharts zoomed it
 * on every wheel, as its own `roam: true` does.
 */
export function ctrlZoomSeries(option: unknown): number[] {
  const series = (option as { series?: unknown } | null)?.series;
  if (!Array.isArray(series)) return [];
  return series.flatMap((s, i) => {
    const { type, layout, roam } = (s ?? {}) as Record<string, unknown>;
    return type === "graph" && layout === "force" && roam === "move" ? [i] : [];
  });
}

/**
 * Zoom a force graph on Ctrl and the wheel, or a trackpad's pinch (which the
 * browser reports as one), about the pointer, as the directed graph's inside
 * zoom does; a plain wheel scrolls the page.
 */
function attachCtrlZoom(chart: echarts.ECharts): () => void {
  const zr = chart.getZr();
  const onWheel = (e: {
    wheelDelta?: number;
    offsetX?: number;
    offsetY?: number;
    event?: WheelEvent;
  }) => {
    if (!e.event?.ctrlKey || !e.wheelDelta) return;
    const indices = ctrlZoomSeries(chart.getOption());
    if (indices.length === 0) return;
    e.event.preventDefault();
    // ECharts' own steps: a mouse wheel's notch is larger than a trackpad's.
    const delta = Math.abs(e.wheelDelta);
    const factor = delta > 3 ? 1.4 : delta > 1 ? 1.2 : 1.1;
    for (const seriesIndex of indices) {
      chart.dispatchAction({
        type: "graphRoam",
        seriesIndex,
        zoom: e.wheelDelta > 0 ? factor : 1 / factor,
        originX: e.offsetX,
        originY: e.offsetY,
      });
    }
  };
  zr.on("mousewheel", onWheel);
  return () => zr.off("mousewheel", onWheel);
}

/** One press of a roam control: zoom, put the view back, or move it a step. */
export type RoamStep = "in" | "out" | "reset" | "left" | "right" | "up" | "down";

/**
 * How a chart's option roams, if it does (#682): by its axes' inside zoom (a
 * directed graph) or by its series' own roam (a force graph). A chart that
 * does neither, or whose inside zoom is off (a directed graph drawn as boxes,
 * which fits the panel whole), has nothing to zoom or pan.
 */
export function roamKind(option: unknown): "axes" | "series" | undefined {
  if (ctrlZoomSeries(option).length > 0) return "series";
  const zooms = (option as { dataZoom?: unknown } | null)?.dataZoom;
  const inside = Array.isArray(zooms) ? zooms : zooms ? [zooms] : [];
  return inside.some((z) => {
    const { type, disabled } = (z ?? {}) as Record<string, unknown>;
    return type === "inside" && disabled !== true;
  })
    ? "axes"
    : undefined;
}

/** A zoom step, as one of ECharts' own wheel notches. */
const ROAM_ZOOM = 1.4;
/** A pan step: this share of what is in view. */
const ROAM_PAN = 0.2;

/**
 * Move the view the way the step's arrow points, so what was off that side
 * comes in; zoom about the middle; or put it back as it was drawn.
 */
export function roamChart(chart: echarts.ECharts, step: RoamStep): void {
  const option = chart.getOption();
  const kind = roamKind(option);
  if (kind === "series") {
    const indices = ctrlZoomSeries(option);
    if (step === "reset") {
      // Merged by index: the series before a roaming one are left as they are.
      const series: Record<string, unknown>[] = [];
      for (const i of indices) series[i] = { center: null, zoom: 1 };
      chart.setOption({ series: Array.from(series, (s) => s ?? {}) });
      return;
    }
    const w = chart.getWidth();
    const h = chart.getHeight();
    for (const seriesIndex of indices) {
      chart.dispatchAction({
        type: "graphRoam",
        seriesIndex,
        ...(step === "in" || step === "out"
          ? {
              zoom: step === "in" ? ROAM_ZOOM : 1 / ROAM_ZOOM,
              originX: w / 2,
              originY: h / 2,
            }
          : {
              // The content moves the other way to the view.
              dx: step === "left" ? w * ROAM_PAN : step === "right" ? -w * ROAM_PAN : 0,
              dy: step === "up" ? h * ROAM_PAN : step === "down" ? -h * ROAM_PAN : 0,
            }),
      });
    }
    return;
  }
  if (kind !== "axes") return;
  const zooms = (option.dataZoom ?? []) as {
    type?: string;
    disabled?: boolean;
    yAxisIndex?: unknown;
    start?: number;
    end?: number;
  }[];
  zooms.forEach((z, dataZoomIndex) => {
    if (z.type !== "inside" || z.disabled) return;
    const vertical = z.yAxisIndex !== undefined;
    const start = z.start ?? 0;
    const end = z.end ?? 100;
    const span = end - start;
    let next: [number, number] | undefined;
    if (step === "reset") next = [0, 100];
    else if (step === "in" || step === "out") {
      const mid = (start + end) / 2;
      const half = Math.min(
        50,
        (step === "in" ? span / ROAM_ZOOM : span * ROAM_ZOOM) / 2,
      );
      next = [mid - half, mid + half];
    } else {
      // A y axis runs bottom to top, so up is toward its end; inverted (the
      // graph's, its first layer at the top) toward its start, as left is.
      const yAxis = ([] as { inverse?: boolean }[]).concat(
        (option.yAxis ?? []) as { inverse?: boolean }[],
      )[0];
      const upIsBack = yAxis?.inverse === true;
      const back = vertical ? step === (upIsBack ? "up" : "down") : step === "left";
      const fore = vertical ? step === (upIsBack ? "down" : "up") : step === "right";
      if (back || fore) next = [start + (fore ? 1 : -1) * span * ROAM_PAN, end];
      if (next) next[1] = next[0] + span;
    }
    if (!next) return;
    // Held inside the whole: shifted back in rather than cut, so a pan at
    // the edge stops and a zoom near it keeps its size.
    const size = next[1] - next[0];
    const from = Math.min(Math.max(0, next[0]), 100 - size);
    chart.dispatchAction({
      type: "dataZoom",
      dataZoomIndex,
      start: from,
      end: from + size,
    });
  });
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
