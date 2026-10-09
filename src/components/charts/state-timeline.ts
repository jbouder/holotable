import type { CustomSeriesRenderItem, EChartsOption } from "echarts";
import { graphic } from "echarts";
import {
  asInstant,
  type ChartContext,
  type ChartOptionBuilder,
  isNumeric,
  normalized,
  type PanelData,
  toText,
} from "@/components/charts/options";
import type { Panel } from "@/lib/ir";
import { type ColorToken, fallbackToken, tokenHex } from "@/lib/panels/colors";
import { StateTimelineOptions } from "@/lib/panels/kinds/state-timeline";
import { formatDateTime, type TimeDisplay } from "@/lib/time-display";

/**
 * The state-timeline kind (#201): discrete states over time, one lane per
 * entity.
 *
 * The model writes only SQL: rows of (time, entity, state). The spans are
 * built here, from the rows the panel holds: a span runs from a row's time to
 * the next row's time for the same entity, and consecutive rows in the same
 * state are one span. The last span of each lane is still open, and ends at
 * the end of the window the server resolved, never at the viewer's clock;
 * before the server has said what that is, it ends at the newest row.
 */

/** Lanes past this are counted, not drawn. */
export const STATE_LANES_MAX = 20;
/** Cells across the window in the `history` variant. */
export const HISTORY_CELLS = 40;

export interface StateSpan {
  lane: number;
  start: number;
  end: number;
  state: string;
}

export interface StateTimeline {
  lanes: string[];
  spans: StateSpan[];
  /** Every state seen, in first-seen order. */
  states: string[];
  /** Entities past {@link STATE_LANES_MAX}, which are not drawn. */
  hiddenLanes: number;
  /** The x-axis range. */
  from: number;
  to: number;
}

/** A panel's state-timeline options, or the defaults when they do not parse. */
export function stateTimelineOptions(panel: Panel): StateTimelineOptions {
  const parsed = StateTimelineOptions.safeParse(panel.options ?? {});
  return parsed.success ? parsed.data : {};
}

/**
 * What a state is colored when nobody said: the obvious ones read as what
 * they mean, and anything else gets a stable color of its own.
 */
const SEMANTIC: Record<string, ColorToken> = {
  up: "success",
  ok: "success",
  healthy: "success",
  running: "success",
  success: "success",
  succeeded: "success",
  passing: "success",
  resolved: "success",
  down: "danger",
  error: "danger",
  failed: "danger",
  failure: "danger",
  failing: "danger",
  critical: "danger",
  firing: "danger",
  warn: "warning",
  warning: "warning",
  degraded: "warning",
  pending: "warning",
  unknown: "neutral",
  idle: "neutral",
  stopped: "neutral",
};

export function stateColor(state: string, panel: Panel): ColorToken {
  const mapped = stateTimelineOptions(panel).states?.find((s) => s.state === state);
  return mapped?.color ?? SEMANTIC[state.toLowerCase()] ?? fallbackToken(state);
}

/**
 * Which columns a state timeline reads: the time, the state and the entity
 * (one lane each). Shared with the drilldown (#373), which maps a clicked span
 * back to a row through the same columns.
 */
export function stateTimelineKeys(
  panel: Panel,
  data: PanelData,
): { timeField?: string; stateKey?: string; entityKey?: string } {
  const options = stateTimelineOptions(panel);
  const timeField = panel.query?.timeField ?? data.columns[0];
  const text = data.columns.filter((c) => c !== timeField);
  const stateKey =
    (options.state && data.columns.includes(options.state) ? options.state : undefined) ??
    text.filter((c) => c !== options.entity).at(-1);
  const entityKey =
    (options.entity && data.columns.includes(options.entity)
      ? options.entity
      : undefined) ?? text.find((c) => c !== stateKey && !isNumeric(data.rows, c));
  return { timeField, stateKey, entityKey };
}

/** Build the lanes and spans for these rows. Pure. */
export function buildStateTimeline(
  panel: Panel,
  data: PanelData,
  window?: ChartContext["window"],
): StateTimeline {
  const options = stateTimelineOptions(panel);
  const { timeField, stateKey, entityKey } = stateTimelineKeys(panel, data);

  const empty: StateTimeline = {
    lanes: [],
    spans: [],
    states: [],
    hiddenLanes: 0,
    from: window?.from ?? 0,
    to: window?.to ?? 0,
  };
  if (!timeField || !stateKey) return empty;

  // Group by entity in first-seen order, each lane's points in time order.
  const byEntity = new Map<string, { at: number; state: string }[]>();
  let newest = Number.NEGATIVE_INFINITY;
  let oldest = Number.POSITIVE_INFINITY;
  for (const row of data.rows) {
    const at = asInstant(row[timeField])?.getTime();
    if (at === undefined) continue;
    const entity = entityKey === undefined ? "" : toText(row[entityKey]);
    const state = toText(row[stateKey]);
    const points = byEntity.get(entity) ?? [];
    if (points.length === 0) byEntity.set(entity, points);
    points.push({ at, state });
    newest = Math.max(newest, at);
    oldest = Math.min(oldest, at);
  }
  if (byEntity.size === 0) return empty;

  const from = window?.from ?? oldest;
  const to = Math.max(window?.to ?? newest, newest);
  const entities = [...byEntity.keys()];
  const lanes = entities.slice(0, STATE_LANES_MAX);
  const states: string[] = [];
  const spans: StateSpan[] = [];

  lanes.forEach((entity, lane) => {
    const points = (byEntity.get(entity) ?? []).sort((a, b) => a.at - b.at);
    let open: StateSpan | null = null;
    for (const point of points) {
      if (!states.includes(point.state)) states.push(point.state);
      if (open && open.state === point.state) continue;
      if (open) {
        open.end = point.at;
        spans.push(open);
      }
      open = { lane, start: point.at, end: to, state: point.state };
    }
    if (open) spans.push(open);
  });

  return {
    lanes,
    spans: options.variant === "history" ? toCells(spans, lanes.length, from, to) : spans,
    states,
    hiddenLanes: entities.length - lanes.length,
    from,
    to,
  };
}

/**
 * The `history` variant: fixed cells across the window, each in the state that
 * held at its middle. A cell before a lane's first row is left empty.
 */
function toCells(
  spans: StateSpan[],
  lanes: number,
  from: number,
  to: number,
): StateSpan[] {
  if (to <= from) return spans;
  const width = (to - from) / HISTORY_CELLS;
  const cells: StateSpan[] = [];
  for (let lane = 0; lane < lanes; lane++) {
    const own = spans.filter((s) => s.lane === lane);
    for (let c = 0; c < HISTORY_CELLS; c++) {
      const start = from + c * width;
      const middle = start + width / 2;
      const span = own.find((s) => s.start <= middle && middle < s.end);
      if (span) cells.push({ lane, start, end: start + width, state: span.state });
    }
  }
  return cells;
}

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}

/**
 * One span as a rectangle, labelled with its state when it is wide enough to
 * hold the word. In the span itself rather than in a legend: a legend would
 * need a series per state, and a series count that changes between updates is
 * what a merged `setOption` cannot take back (invariant 11).
 */
function renderSpan(timeline: StateTimeline): CustomSeriesRenderItem {
  return (params, api) => {
    const lane = api.value(0) as number;
    const start = api.coord([api.value(1), lane]);
    const end = api.coord([api.value(2), lane]);
    const size = api.size?.([0, 1]);
    const height = (Array.isArray(size) ? size[1] : 0) * 0.6;
    const coordSys = params.coordSys as unknown as {
      x: number;
      y: number;
      width: number;
      height: number;
    };
    const shape = graphic.clipRectByRect(
      {
        x: start[0],
        y: start[1] - height / 2,
        width: Math.max(1, end[0] - start[0]),
        height,
      },
      { x: coordSys.x, y: coordSys.y, width: coordSys.width, height: coordSys.height },
    );
    if (!shape) return null;
    const rect = {
      type: "rect" as const,
      shape,
      style: { fill: api.visual("color") },
    };
    const state = timeline.spans[params.dataIndex]?.state ?? "";
    if (shape.width < 48 || state === "") return rect;
    return {
      type: "group",
      children: [
        rect,
        {
          type: "text",
          silent: true,
          style: {
            text: state,
            x: shape.x + 6,
            y: shape.y + shape.height / 2,
            verticalAlign: "middle",
            fill: "#0b0d12",
            fontSize: 11,
            width: shape.width - 12,
            overflow: "truncate",
          },
        },
      ],
    };
  };
}

function tooltip(timeline: StateTimeline, display: TimeDisplay) {
  return (p: unknown) => {
    const span = timeline.spans[(p as { dataIndex: number }).dataIndex];
    if (!span) return "";
    const lane = timeline.lanes[span.lane];
    const when = (ms: number) => formatDateTime(new Date(ms), display, { seconds: true });
    return [
      `<strong>${escapeHtml(span.state)}</strong>${lane ? ` · ${escapeHtml(lane)}` : ""}`,
      `${when(span.start)} → ${when(span.end)}`,
      duration(span.end - span.start),
    ].join("<br/>");
  };
}

export const stateTimelineChart: ChartOptionBuilder = normalized((panel, data, ctx) => {
  const timeline = buildStateTimeline(panel, data, ctx.window);
  return {
    backgroundColor: "transparent",
    tooltip: {
      trigger: "item",
      borderRadius: 0,
      formatter: tooltip(timeline, ctx.display),
    },
    // Always set, so a count that drops to zero clears rather than lingers.
    title: {
      text: timeline.hiddenLanes > 0 ? `+${timeline.hiddenLanes} more not shown` : "",
      right: 0,
      bottom: 0,
      textStyle: { color: "#9aa0aa", fontSize: 11, fontWeight: "normal" },
    },
    // Room on the right for the last time label, which is centred on the
    // window's end.
    grid: { left: 8, right: 48, top: 8, bottom: 40, containLabel: true },
    xAxis: {
      type: "time",
      min: timeline.from,
      max: timeline.to,
      axisLabel: {
        color: "#9aa0aa",
        hideOverlap: true,
        formatter: (v: number) =>
          formatDateTime(new Date(v), ctx.display, { seconds: false }),
      },
      axisLine: { lineStyle: { color: "#3a3f4b" } },
      splitLine: { show: false },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: timeline.lanes,
      axisLabel: { color: "#9aa0aa" },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "custom",
        renderItem: renderSpan(timeline),
        encode: { x: [1, 2], y: 0 },
        data: timeline.spans.map((s) => ({
          value: [s.lane, s.start, s.end],
          itemStyle: { color: tokenHex(stateColor(s.state, panel)) },
        })),
      },
    ],
  } satisfies EChartsOption;
});

export function stateTimelineShape(panel: Panel): string {
  return stateTimelineOptions(panel).variant ?? "spans";
}
