import { panelTimeField } from "@/lib/ir";
import type { CustomSeriesRenderItem, EChartsOption } from "echarts";
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
import { type ColorToken, defaultStateToken, fillHex } from "@/lib/panels/colors";
import { type ChartTheme, inkOn, soften } from "@/lib/color/chart-theme";
import {
  blockLabel,
  categoryAxis,
  shared,
  spanCorner,
  text,
  tooltip,
} from "@/components/charts/style";
import { StateTimelineOptions } from "@/lib/panels/kinds/state-timeline";
import { type ChartSize, labelBudget } from "@/components/charts/size";
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

export function stateColor(state: string, panel: Panel): ColorToken {
  const mapped = stateTimelineOptions(panel).states?.find((s) => s.state === state);
  return mapped?.color ?? defaultStateToken(state);
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
  const timeField = panelTimeField(panel) ?? data.columns[0];
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

/** Text as HTML an ECharts tooltip can show, never markup. */
export function escapeHtml(text: string): string {
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
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `rect` cut to the part inside `clip`, or null when none of it is. What
 * ECharts' `graphic.clipRectByRect` does, kept here so this module needs no
 * ECharts at runtime and the chart library loads only with a chart (#497).
 */
export function clipRect(rect: Rect, clip: Rect): Rect | null {
  const x = Math.max(rect.x, clip.x);
  const y = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y };
}

function renderSpan(timeline: StateTimeline, theme: ChartTheme): CustomSeriesRenderItem {
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
    const shape = clipRect(
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
      // The page's corners on a span wide enough to carry them.
      shape: { ...shape, r: spanCorner(theme, shape) },
      style: { fill: api.visual("color") },
    };
    const state = timeline.spans[params.dataIndex]?.state ?? "";
    // The state is written in a span with room for the word, across and up.
    const label = blockLabel(theme);
    if (shape.width < 48 || shape.height < label.fontSize + 2 || state === "")
      return rect;
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
            fill: inkOn(String(api.visual("color"))),
            ...label,
            width: shape.width - 12,
            overflow: "truncate",
          },
        },
      ],
    };
  };
}

function spanTooltip(timeline: StateTimeline, display: TimeDisplay) {
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

/** The least a lane is drawn at: its span's bar is 60% of it. */
const LANE_MIN_PX = 12;
/** A lane that also writes its name beside it: a line of label text. */
const LANE_LABEL_PX = 16;
/** What the timeline spends down the chart besides its lanes: the time axis and margins. */
const TIMELINE_CHROME_PX = 36;
/** Below this width a timeline's axis writes times without their day. */
const TIMELINE_DATES_PX = 240;
/** The note under the lanes that counts the ones not drawn. */
const TIMELINE_NOTE_PX = 16;

/**
 * How many lanes a timeline draws at a size, and whether their names fit
 * (#643). Every lane while each has room for its bar; past that the first
 * lanes that do, at least one, and the rest are counted in the note, so the
 * bars never vanish. Names are written while each lane has a line of text,
 * and left to the tooltip and the table below that.
 */
export function timelineLanesFit(
  size: ChartSize | undefined,
  count: number,
): { shown: number; labels: boolean } {
  const all = labelBudget(size, count, { need: LANE_MIN_PX, chrome: TIMELINE_CHROME_PX });
  const shown = all.show
    ? count
    : Math.max(
        1,
        Math.floor(
          ((size?.height ?? 0) - TIMELINE_CHROME_PX - TIMELINE_NOTE_PX) / LANE_MIN_PX,
        ),
      );
  const labels = labelBudget(size, Math.min(count, shown), {
    need: LANE_LABEL_PX,
    chrome: TIMELINE_CHROME_PX + (shown < count ? TIMELINE_NOTE_PX : 0),
  }).show;
  return { shown: Math.min(count, shown), labels };
}

export const stateTimelineChart: ChartOptionBuilder = normalized((panel, data, ctx) => {
  const built = buildStateTimeline(panel, data, ctx.window);
  const fit = timelineLanesFit(ctx.size, built.lanes.length);
  // The lanes past the ones that fit are counted, not drawn. Spans run lane
  // by lane, so the ones kept are the first and keep their indices, which is
  // what a click maps back through (#373).
  const timeline: StateTimeline = {
    ...built,
    lanes: built.lanes.slice(0, fit.shown),
    spans: built.spans.filter((s) => s.lane < fit.shown),
    hiddenLanes: built.hiddenLanes + built.lanes.length - fit.shown,
  };
  // A narrow timeline's axis writes the time alone, and half a time is the
  // room an edge label needs.
  const dates = !ctx.size || ctx.size.width >= TIMELINE_DATES_PX;
  const edge = dates ? 48 : 32;
  return {
    ...shared(ctx.theme),
    tooltip: {
      ...tooltip(ctx.theme),
      trigger: "item",
      formatter: spanTooltip(timeline, ctx.display),
    },
    // Always set, so a count that drops to zero clears rather than lingers.
    title: {
      text: timeline.hiddenLanes > 0 ? `+${timeline.hiddenLanes} more not shown` : "",
      right: 0,
      bottom: 0,
      textStyle: { ...text(ctx.theme), fontWeight: "normal" },
    },
    // Room on the right for the last time label, which is centred on the
    // window's end.
    // The lane names make that room on the left; without them the first
    // label has the same room as the last (#643).
    grid: {
      left: fit.labels ? 8 : edge,
      right: edge,
      top: 8,
      bottom: timeline.hiddenLanes > 0 ? 8 + TIMELINE_NOTE_PX : 8,
      // The axis labels are held inside the chart, the first and last too.
      outerBoundsMode: "same",
      outerBoundsContain: "all",
    },
    xAxis: {
      type: "time",
      min: timeline.from,
      max: timeline.to,
      ...categoryAxis(ctx.theme),
      axisLabel: {
        ...text(ctx.theme),
        hideOverlap: true,
        // The first and last labels stay inside a narrow panel, not centred
        // off its edges (#643).
        alignMinLabel: "left",
        alignMaxLabel: "right",
        // A narrow timeline writes the time alone: the day is in the tooltip.
        formatter: (v: number) =>
          formatDateTime(new Date(v), ctx.display, {
            seconds: false,
            date: dates,
          }),
      },
    },
    yAxis: {
      ...categoryAxis(ctx.theme),
      type: "category",
      inverse: true,
      data: timeline.lanes,
      // Each lane drawn has its line when names are written, so none is skipped.
      axisLabel: { ...text(ctx.theme), show: fit.labels, interval: 0 },
    },
    series: [
      {
        type: "custom",
        renderItem: renderSpan(timeline, ctx.theme),
        encode: { x: [1, 2], y: 0 },
        data: timeline.spans.map((s) => ({
          value: [s.lane, s.start, s.end],
          // A span is a large area: softened, as every block is.
          itemStyle: {
            color: soften(ctx.theme, fillHex(stateColor(s.state, panel), ctx.theme)),
          },
        })),
      },
    ],
  } satisfies EChartsOption;
});

export function stateTimelineShape(panel: Panel): string {
  return stateTimelineOptions(panel).variant ?? "spans";
}
