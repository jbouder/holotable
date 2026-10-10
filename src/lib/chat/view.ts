import { Panel, type QueryPanel, type VizType, queryTimeField } from "@/lib/ir";

/**
 * Redrawing a Chat panel as another kind (#416), without asking the model again.
 *
 * Browser-safe and pure. The rows are the ones the guarded query already
 * returned; only the panel that draws them changes, and every panel built here
 * is held to the IR's own `Panel` schema before it is drawn or saved, so a
 * toggle can never produce a spec the server would refuse.
 */

/** The kinds a result can be switched to. Line and area need a time field. */
export const CHAT_VIEWS = ["line", "area", "bar", "table", "stat"] as const;

const SERIES_KINDS: ReadonlySet<VizType> = new Set(["line", "area", "bar"]);

/** Whether a kind takes the shared series options (legend, stack, axis). */
export function isSeriesView(viz: VizType): boolean {
  return SERIES_KINDS.has(viz);
}

/** How the result is drawn: the kind, and the series toggles it takes. */
export interface ViewSettings {
  viz: VizType;
  legend: boolean;
  stacked: boolean;
  log: boolean;
}

/** A column's order in the table view. */
export interface TableSort {
  column: string;
  order: "asc" | "desc";
}

/** What the table view keeps beside the rows: hidden columns and the order. */
export interface TableView {
  hidden: string[];
  sort: TableSort | null;
}

export const EMPTY_TABLE_VIEW: TableView = { hidden: [], sort: null };

type Options = Record<string, unknown>;

function optionsOf(panel: QueryPanel): Options {
  return (panel.options as Options | undefined) ?? {};
}

/**
 * The kinds offered for this result: the one the model chose, then every
 * switchable kind the query can feed (line and area only with a time field).
 */
export function viewChoices(panel: QueryPanel): VizType[] {
  const timed = Boolean(queryTimeField(panel.query));
  const views: VizType[] = CHAT_VIEWS.filter(
    (v) => timed || (v !== "line" && v !== "area"),
  );
  return views.includes(panel.viz) ? views : [panel.viz, ...views];
}

/** The settings a result starts with: exactly as the model drew it. */
export function initialView(panel: QueryPanel): ViewSettings {
  const options = isSeriesView(panel.viz) ? optionsOf(panel) : {};
  const axis = (options.yAxis as Options | undefined) ?? {};
  return {
    viz: panel.viz,
    legend: options.legend !== "none",
    stacked: options.stacked === true,
    log: axis.log === true,
  };
}

/** The table settings a result starts with: the model's own sort, if it set one. */
export function initialTableView(panel: QueryPanel): TableView {
  if (panel.viz !== "table") return EMPTY_TABLE_VIEW;
  const options = optionsOf(panel);
  const sort = options.sort as { column: string; order?: "asc" | "desc" } | undefined;
  const columns = (options.columns as { name: string; hidden?: boolean }[]) ?? [];
  return {
    hidden: columns.filter((c) => c.hidden).map((c) => c.name),
    sort: sort ? { column: sort.column, order: sort.order ?? "asc" } : null,
  };
}

/** Drop the keys left `undefined`, so an untouched panel stays as it was. */
function compact(options: Options): Options | undefined {
  const entries = Object.entries(options).filter(([, v]) => v !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function seriesOptions(panel: QueryPanel, view: ViewSettings): Options | undefined {
  const base = isSeriesView(panel.viz) ? optionsOf(panel) : {};
  const { yAxis, legend, stacked: _stacked, ...rest } = base;
  const axis = compact({
    ...((yAxis as Options | undefined) ?? {}),
    log: view.log || undefined,
  });
  return compact({
    ...rest,
    // Keep the model's position when the legend is on; `none` turns it off.
    legend: view.legend ? (legend === "none" ? undefined : legend) : "none",
    stacked: view.stacked || undefined,
    yAxis: axis,
  });
}

function tableOptions(panel: QueryPanel, table: TableView): Options | undefined {
  const base = panel.viz === "table" ? optionsOf(panel) : {};
  const listed = (base.columns as { name: string }[] | undefined) ?? [];
  const columns = listed.map((c) => ({
    ...c,
    hidden: table.hidden.includes(c.name) || undefined,
  }));
  for (const name of table.hidden) {
    if (!listed.some((c) => c.name === name)) columns.push({ name, hidden: true });
  }
  return compact({
    ...base,
    columns: columns.length > 0 ? columns.map((c) => compact(c)) : undefined,
    sort: table.sort ?? undefined,
  });
}

/**
 * The panel as currently shown, which is also what Save as panel saves. `null`
 * when the settings make no valid panel (a log axis whose fixed minimum is not
 * above zero, say), so the caller keeps the last good one.
 */
export function viewPanel(
  panel: QueryPanel,
  view: ViewSettings,
  table: TableView,
): QueryPanel | null {
  let options: Options | undefined;
  if (isSeriesView(view.viz)) options = seriesOptions(panel, view);
  else if (view.viz === "table") options = tableOptions(panel, table);
  else if (view.viz === panel.viz) options = panel.options as Options | undefined;
  const { options: _dropped, ...rest } = panel;
  const candidate = { ...rest, viz: view.viz, ...(options ? { options } : {}) };
  return Panel.safeParse(candidate).success ? (candidate as QueryPanel) : null;
}
