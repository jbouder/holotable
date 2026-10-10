import { panelTimeField } from "@/lib/ir";
import { gaugeOptions, gaugeReadings } from "@/components/charts/gauge";
import { histogramBars } from "@/components/charts/histogram";
import {
  asInstant,
  type ChartContext,
  isNumeric,
  normalize,
  type PanelData,
  toText,
} from "@/components/charts/options";
import {
  buildStateTimeline,
  stateTimelineKeys,
} from "@/components/charts/state-timeline";
import type { Datum } from "@/lib/drilldown";
import type { Panel, VizType } from "@/lib/ir";
import { statusGrid, tableView } from "@/lib/panel-reading";

/**
 * From a click to the row it was drawn from (#373): one mapping per
 * registered kind, and `satisfies Record<VizType, …>` refuses a kind
 * registered without one, as the renderer registry does.
 *
 * The rows are the ones the panel already holds, normalized exactly as the
 * chart builders normalize them, so an index ECharts reports is an index into
 * the same list the chart was drawn from. Nothing here runs a query.
 */

/** What a click reports: ECharts' `seriesName`, `dataIndex` and datum `name`. */
export interface DatumClick {
  seriesName?: string;
  dataIndex?: number;
  name?: string;
}

type DatumMapper = (
  panel: Panel,
  data: PanelData,
  click: DatumClick,
  window?: ChartContext["window"],
) => Datum | null;

function at<T>(list: readonly T[], index: number | undefined): T | undefined {
  return index !== undefined && Number.isInteger(index) && index >= 0
    ? list[index]
    : undefined;
}

/**
 * The series of a row on a kind that draws one series per numeric column
 * (`line`, `area`, `bar`, `scatter`): the clicked one when the click named it,
 * else the only one there is. A row with several says no series.
 */
function seriesOfColumns(
  data: PanelData,
  click: DatumClick,
  numericSkip: string | undefined,
): string | undefined {
  if (click.seriesName !== undefined) return click.seriesName;
  const keys = data.columns.filter((c) => c !== numericSkip && isNumeric(data.rows, c));
  return keys.length === 1 ? keys[0] : undefined;
}

/** One row per point, in row order: what `line`, `area` and `bar` draw. */
const byRowIndex: DatumMapper = (panel, data, click) => {
  const row = at(data.rows, click.dataIndex);
  if (!row) return null;
  const x = panelTimeField(panel) ?? data.columns[0];
  return { row, series: seriesOfColumns(data, click, x) };
};

/** A scatter plots the first numeric column against the rest. */
const scatterDatum: DatumMapper = (_panel, data, click) => {
  const row = at(data.rows, click.dataIndex);
  if (!row) return null;
  const x = data.columns.find((c) => isNumeric(data.rows, c));
  return { row, series: seriesOfColumns(data, click, x) };
};

/** A slice is a row; its series is its label, the category column's value. */
const sliceDatum: DatumMapper = (panel, data, click) => {
  const row = at(data.rows, click.dataIndex);
  if (!row) return null;
  const x = panelTimeField(panel) ?? data.columns[0] ?? "x";
  return { row, series: click.name ?? toText(row[x]) };
};

/** A heatmap's cells are its rows, in order; its series is the row's y value. */
const cellDatum: DatumMapper = (_panel, data, click) => {
  const row = at(data.rows, click.dataIndex);
  if (!row) return null;
  const y = data.columns[1];
  return { row, series: y === undefined ? undefined : toText(row[y]) };
};

/**
 * A span is a lane's run of one state: the row is that lane's newest row in
 * that state inside the span, and the series is the lane (the entity).
 */
const spanDatum: DatumMapper = (panel, data, click, window) => {
  const timeline = buildStateTimeline(panel, data, window);
  const span = at(timeline.spans, click.dataIndex);
  if (!span) return null;
  const lane = timeline.lanes[span.lane];
  const { timeField, stateKey, entityKey } = stateTimelineKeys(panel, data);
  if (!timeField || !stateKey) return null;
  const row = data.rows.findLast((r) => {
    const t = asInstant(r[timeField])?.getTime();
    return (
      t !== undefined &&
      t >= span.start &&
      t <= span.end &&
      toText(r[stateKey]) === span.state &&
      (entityKey === undefined || toText(r[entityKey]) === lane)
    );
  });
  return row ? { row, series: lane } : null;
};

/** A dial is the latest row; a bar is the reading with that label. */
const gaugeDatum: DatumMapper = (panel, data, click) => {
  const readings = gaugeReadings(panel, data);
  const reading =
    gaugeOptions(panel).variant === "bar"
      ? (readings.find((r) => r.label === click.name) ?? at(readings, click.dataIndex))
      : readings[0];
  return reading ? { row: reading.row, series: reading.label } : null;
};

/** A stat is one value, read off its last row: the whole panel is the datum. */
const statDatum: DatumMapper = (_panel, data) => {
  const row = data.rows.at(-1);
  return row ? { row } : null;
};

/** A table click is a row of the table as shown, sorted by its options. */
const tableDatum: DatumMapper = (panel, data, click) => {
  const row = at(tableView(panel, data).rows, click.dataIndex);
  return row ? { row } : null;
};

/** A tile is its entity's latest row; its series is the tile's label. */
const tileDatum: DatumMapper = (panel, data, click) => {
  const { tiles } = statusGrid(panel, data);
  const tile = tiles.find((t) => t.label === click.name) ?? at(tiles, click.dataIndex);
  return tile ? { row: tile.row, series: tile.label } : null;
};

/** A bar is a bucket: its row is the bucket and its summed count. */
const barDatum: DatumMapper = (panel, data, click) => {
  const bar = at(histogramBars(panel, data).bars, click.dataIndex);
  return bar ? { row: bar.row, series: bar.label } : null;
};

export const DATUM_MAPPERS = {
  line: byRowIndex,
  area: byRowIndex,
  bar: byRowIndex,
  scatter: scatterDatum,
  stat: statDatum,
  table: tableDatum,
  heatmap: cellDatum,
  pie: sliceDatum,
  donut: sliceDatum,
  gauge: gaugeDatum,
  "state-timeline": spanDatum,
  "status-grid": tileDatum,
  histogram: barDatum,
  // A text panel has no rows and takes no links.
  text: () => null,
} as const satisfies Record<VizType, DatumMapper>;

/** The datum a click on this panel landed on, or null when it cannot say. */
export function datumOf(
  panel: Panel,
  data: PanelData | undefined,
  click: DatumClick,
  window?: ChartContext["window"],
): Datum | null {
  return DATUM_MAPPERS[panel.viz](panel, normalize(data), click, window);
}

/**
 * The datum behind the nth row of a chart's hidden table (#77): the
 * keyboard's way to the same links a click follows. A row stands for the
 * point, slice or cell drawn from it, with the series the kind names per row;
 * a kind whose marks are not one per row (a timeline's spans, a gauge's
 * readings) offers the row alone.
 */
export function datumOfRow(
  panel: Panel,
  data: PanelData | undefined,
  rowIndex: number,
): Datum | null {
  const rows = normalize(data);
  const row = at(rows.rows, rowIndex);
  if (!row) return null;
  const perRow = ["line", "area", "bar", "scatter", "pie", "donut", "heatmap"];
  return perRow.includes(panel.viz)
    ? DATUM_MAPPERS[panel.viz](panel, rows, { dataIndex: rowIndex })
    : { row };
}
