import { asInstant, type PanelData, toNumber, toText } from "@/components/charts/options";
import { formatValue } from "@/lib/format";
import type { Panel } from "@/lib/ir";
import type { ColorToken } from "@/lib/panels/colors";
import {
  numberDisplay,
  readOptions,
  StatOptions,
  type TableColumn,
  TableOptions,
} from "@/lib/panels/presentation";
import { thresholdColor } from "@/lib/panels/thresholds";
import { formatDateTime, LOCAL_TIME_DISPLAY, type TimeDisplay } from "@/lib/time-display";

/**
 * What the HTML-drawn kinds show for a set of rows, worked out apart from
 * drawing it so it can be tested as a function: a stat's number and a table's
 * columns and rows, under the options of #115.
 */

export interface StatReading {
  /** The column the value is read from. */
  column: string | undefined;
  /** The raw value, or undefined when there are no rows. */
  value: unknown;
  text: string;
  /** The threshold step the value is in, when the panel has steps. */
  color?: ColorToken;
  /** The value column across every row, for the sparkline. Empty without one. */
  spark: number[];
}

/**
 * A stat's value: the named column, or else the last row's first numeric
 * column that is not the time field, as it has always been chosen.
 */
export function statReading(panel: Panel, data: PanelData): StatReading {
  const o = readOptions(StatOptions, panel.options);
  const last = data.rows[data.rows.length - 1];
  const named = o.value && data.columns.includes(o.value) ? o.value : undefined;
  const valueKey =
    named ??
    data.columns.find(
      (c) => c !== panel.query?.timeField && typeof last?.[c] === "number",
    ) ??
    data.columns[data.columns.length - 1];
  const value = last?.[valueKey];
  const n = toNumber(value);
  return {
    column: valueKey,
    value,
    text: value === undefined ? "—" : formatValue(value, panel.format, numberDisplay(o)),
    color: Number.isFinite(n) ? thresholdColor(o.thresholds, n) : undefined,
    spark: o.sparkline
      ? data.rows.map((r) => toNumber(r[valueKey])).filter(Number.isFinite)
      : [],
  };
}

/** The most rows a table shows, as before options. */
export const TABLE_ROWS_MAX = 100;

export interface TableViewColumn {
  name: string;
  label: string;
  align?: TableColumn["align"];
  width?: number;
  /** How a cell is written. */
  text: (value: unknown) => string;
}

/**
 * A table's columns and rows. Listed columns first, in their order, then the
 * rest as the result has them; hidden ones left out. Without a sort the rows
 * are the newest {@link TABLE_ROWS_MAX}, as they always were; with one, the
 * first that many in its order.
 */
export function tableView(
  panel: Panel,
  data: PanelData,
): { columns: TableViewColumn[]; rows: Record<string, unknown>[] } {
  const o = readOptions(TableOptions, panel.options);
  const listed = o.columns ?? [];
  const byName = new Map(listed.map((c) => [c.name, c]));
  const order = [
    ...listed.map((c) => c.name).filter((name) => data.columns.includes(name)),
    ...data.columns.filter((name) => !byName.has(name)),
  ];
  const columns = order
    .filter((name) => !byName.get(name)?.hidden)
    .map((name): TableViewColumn => {
      const c = byName.get(name);
      const display = c ? numberDisplay(c) : undefined;
      const formatted = c?.format !== undefined || display !== undefined;
      return {
        name,
        label: c?.label ?? name,
        align: c?.align,
        width: c?.width,
        text: (value) =>
          formatted && value !== null && value !== "" && Number.isFinite(toNumber(value))
            ? formatValue(value, c?.format, display)
            : String(value ?? ""),
      };
    });

  const sort = o.sort;
  if (!sort || !data.columns.includes(sort.column)) {
    return { columns, rows: data.rows.slice(-TABLE_ROWS_MAX) };
  }
  const sign = sort.order === "desc" ? -1 : 1;
  const rows = [...data.rows]
    .sort((a, b) => compareCells(a[sort.column], b[sort.column], sign))
    .slice(0, TABLE_ROWS_MAX);
  return { columns, rows };
}

/** Numbers as numbers, everything else as text; an empty cell is always last. */
function compareCells(a: unknown, b: unknown, sign: number): number {
  const emptyA = a === null || a === undefined || a === "";
  const emptyB = b === null || b === undefined || b === "";
  if (emptyA || emptyB) return emptyA === emptyB ? 0 : emptyA ? 1 : -1;
  const x = toNumber(a);
  const y = toNumber(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return (x - y) * sign;
  return String(a).localeCompare(String(b)) * sign;
}

/** The most rows a chart's screen-reader table carries: the newest ones. */
export const CHART_TABLE_ROWS_MAX = 50;

export interface ChartTable {
  /** Says what the table is, how many rows it holds and of how many. */
  caption: string;
  columns: string[];
  /** Every cell already written as text. */
  rows: string[][];
}

/**
 * The rows behind a canvas chart, as a table a screen reader can walk (#77).
 *
 * A canvas is opaque to assistive technology, so every chart panel renders
 * this beside it, visually hidden. It is the result as it came, newest
 * {@link CHART_TABLE_ROWS_MAX} rows, with timestamps on the reader's clock and
 * values in the panel's format — what the chart shows, not a re-query.
 */
export function chartTable(
  panel: Panel,
  data: PanelData,
  display: TimeDisplay = LOCAL_TIME_DISPLAY,
): ChartTable {
  const rows = data.rows.slice(-CHART_TABLE_ROWS_MAX);
  const timeField = panel.query?.timeField;
  const cell = (column: string, value: unknown): string => {
    const instant = column === timeField ? asInstant(value) : null;
    if (instant) return formatDateTime(instant, display, { seconds: true });
    if (column !== timeField && typeof value === "number") {
      return formatValue(value, panel.format);
    }
    return toText(value);
  };
  const shown =
    rows.length === data.rows.length
      ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}`
      : `the newest ${rows.length} of ${data.rows.length} rows`;
  return {
    caption: `Data for ${panel.title}: ${shown}.`,
    columns: data.columns,
    rows: rows.map((r) => data.columns.map((c) => cell(c, r[c]))),
  };
}

/** A chart's accessible name: its title and its kind, never a value. */
export function chartDescription(panel: Panel, rows: number): string {
  const kind = panel.viz.replace(/-/g, " ");
  return rows === 0
    ? `${panel.title}, ${kind} chart, no data yet.`
    : `${panel.title}, ${kind} chart. The data is in the table that follows.`;
}
