import { exposedCatalogTables, type CatalogSubject } from "@/lib/catalog/health";
import { isPlainIdentifier, timeColumn } from "@/lib/catalog/identifiers";
import { type Dashboard, type Panel, SPEC_VERSION, type TimeRange } from "@/lib/ir";
import type { CatalogColumn, CatalogTable } from "@/lib/registry";
import type { Template, TemplateKind } from "@/lib/templates";

/**
 * Starter dashboards for the files people bring (#606), chosen by the shape of
 * a table's columns and needing no model: a date, an amount and a category is
 * **spending**; a date with a distance and a duration is an **activity log**;
 * a date with several numbers is **daily measurements**.
 *
 * The sibling of `src/lib/builtin-templates.ts` (the golden signals, which
 * look for rate, latency and error columns a bank export or a training log
 * does not have), and built the same way: pure functions over the catalog the
 * source exposes, returning templates whose bodies are IR dashboards naming
 * real tables and real columns. They are derived, never stored, and applied
 * through the same picker, guard and save path as any other template, so
 * nothing here writes and nothing here decides what may run.
 *
 * The rules, which `test/builtin-templates-files.test.ts` holds:
 *
 * - **A time column is required**: the declared `timeField`, else the first
 *   date- or timestamp-typed column (`timeColumn`). Every recognizer is about
 *   change over time, and the time series below are what the dashboard's
 *   window narrows.
 * - **One template per table, the most specific recognizer wins**: an
 *   activity log (it needs a distance *and* a duration), then spending (a
 *   money column *and* a column to break it down by), then daily
 *   measurements (two or more other numbers). A money column with nothing to
 *   break it down by is only a measure, which is what keeps a utility bill's
 *   `cost_usd` a measurement rather than spending; a distance or a duration
 *   without its other half is half an activity log, and gets nothing.
 * - **Names, not statistics.** The catalog records a column's name and type
 *   and nothing about its values, so a role is read off the name. A wrong
 *   guess costs one starter nobody applies.
 * - **Plain identifiers only**, as in the golden signals: a table or column
 *   whose name is not an ordinary unquoted identifier is skipped rather than
 *   escaped (`src/lib/catalog/identifiers.ts`).
 * - **One statement for both dialects.** `date_trunc`, `sum`, `avg`, `count`
 *   and `nullif` mean the same in PostgreSQL (TimescaleDB) and DuckDB, and
 *   grouping is by position (`GROUP BY 1`), so a table that happens to have a
 *   column named like an output alias still groups by the alias.
 * - **No time filter, no clock.** The server owns the window: a time series
 *   aliases its bucket `bucket` and declares it as `timeField`, and the
 *   dashboard's range is a relative expression the server resolves. A
 *   breakdown (a pie, a top-ten table) has no time column for the window to
 *   filter on, so it reads the whole table and says so in its description.
 */

/** How many recognized tables of one catalog get a starter. */
const MAX_TABLES = 6;

/** How many numbers a daily-measurements dashboard charts, one panel each. */
export const MAX_MEASURES = 4;

/**
 * A file is history rather than a live feed, so the window opens a year back:
 * wide enough for a typical export, and the widest the time picker offers. A
 * template cannot know the data's span; this is one click to change.
 */
export const FILE_TIME_RANGE: TimeRange = { from: "now-365d", to: "now" };

/** A file changes when someone adds to it, not every few seconds. */
const FILE_REFRESH_MS = 300_000;

/** Numeric types in PostgreSQL's and DuckDB's spellings. */
const NUMERIC_TYPE =
  /^(tinyint|smallint|integer|bigint|hugeint|utinyint|usmallint|uinteger|ubigint|uhugeint|int1|int2|int4|int8|int|decimal|numeric|real|double|float4|float8|float|money)\b/i;

/** Text types: what a category is stored as. */
const TEXTUAL_TYPE = /^(text|character|varchar|char|string|name|citext|bpchar)\b/i;

/** The underscore-separated words of a name, lowercased. */
function words(name: string): string[] {
  return name.toLowerCase().split("_").filter(Boolean);
}

function hasWord(column: CatalogColumn, names: readonly string[]): boolean {
  return words(column.name).some((w) => names.includes(w));
}

/** Names that say a number is money. */
const MONEY = [
  "amount",
  "amt",
  "total",
  "cost",
  "price",
  "value",
  "debit",
  "credit",
  "spend",
  "spent",
  "paid",
  "charge",
  "usd",
  "eur",
  "gbp",
  "cad",
  "aud",
];

/** Names that classify a payment: the breakdown, in order of preference. */
const CATEGORY = [
  "category",
  "categories",
  "type",
  "kind",
  "class",
  "group",
  "tag",
  "account",
  "method",
];

/** Names that say who was paid. */
const MERCHANT = [
  "merchant",
  "payee",
  "vendor",
  "store",
  "shop",
  "counterparty",
  "recipient",
  "description",
];

/** Words that read as a distance, and the unit each implies (null: none). */
const DISTANCE_UNIT = new Map<string, string | null>([
  ["distance", null],
  ["km", "km"],
  ["kilometers", "km"],
  ["kilometres", "km"],
  ["mi", "mi"],
  ["miles", "mi"],
  ["meters", "m"],
  ["metres", "m"],
]);

/**
 * Words that make a number a duration on their own, and how many of the unit
 * make an hour, the factor a speed in distance per hour needs (null: a unit
 * the name does not say, whose speed is shown per that unit).
 */
const DURATION_WORD = new Map<string, number | null>([
  ["duration", null],
  ["elapsed", null],
  ["minutes", 60],
  ["mins", 60],
  ["seconds", 3600],
  ["secs", 3600],
  ["hours", 1],
  ["hrs", 1],
]);

/**
 * Short units, which name a duration's unit only as the last word after a
 * time word (`duration_min`, `moving_time_s`): alone, `min` is as likely a
 * minimum and `hr` a heart rate.
 */
const DURATION_UNIT = new Map<string, number>([
  ["min", 60],
  ["s", 3600],
  ["sec", 3600],
  ["h", 1],
  ["hr", 1],
]);
const TIME_WORD = ["duration", "elapsed", "time", "moving"];

/** Names that classify an activity. */
const ACTIVITY_TYPE = ["type", "sport", "activity", "kind", "category"];

/** Names that read as a heart rate. */
const HEART = ["heart", "hr", "bpm", "pulse"];

/**
 * Numbers that are keys rather than measures (an `id`, a `zip`), by any word
 * of the name, and calendar parts beside the date (a `year` or `month`
 * column), by the whole name so `kwh_per_day` is still a measure. Never
 * charted.
 */
const KEY_WORDS = ["id", "uuid", "key", "code", "zip", "postcode", "index", "idx", "seq"];
const CALENDAR = new Set([
  "year",
  "quarter",
  "month",
  "week",
  "day",
  "weekday",
  "hour",
  "minute",
  "lat",
  "latitude",
  "lon",
  "lng",
  "longitude",
]);

function isMeasure(column: CatalogColumn): boolean {
  return (
    NUMERIC_TYPE.test(column.type.trim()) &&
    !hasWord(column, KEY_WORDS) &&
    !CALENDAR.has(column.name.toLowerCase())
  );
}

/** A table's usable columns, by role, with the time column set apart. */
interface Shape {
  table: string;
  time: string;
  numbers: CatalogColumn[];
  texts: CatalogColumn[];
}

/** The table as the recognizers read it, or null when it has no time column. */
function shapeOf(table: CatalogTable): Shape | null {
  if (!isPlainIdentifier(table.name)) return null;
  const time = timeColumn(table);
  if (!time) return null;
  const usable = table.columns.filter(
    (c) => isPlainIdentifier(c.name) && c.name !== time,
  );
  return {
    table: table.name,
    time,
    numbers: usable.filter(isMeasure),
    texts: usable.filter((c) => TEXTUAL_TYPE.test(c.type.trim())),
  };
}

/** The first column whose words include the earliest-listed name that any has. */
function byPreference(
  columns: CatalogColumn[],
  names: readonly string[],
): CatalogColumn | undefined {
  for (const name of names) {
    const found = columns.find((c) => words(c.name).includes(name));
    if (found) return found;
  }
  return undefined;
}

/** The unit a distance column's name implies, or null. */
function distanceUnit(column: CatalogColumn): string | null {
  for (const w of words(column.name)) {
    const unit = DISTANCE_UNIT.get(w);
    if (unit) return unit;
  }
  return null;
}

const isDistance = (c: CatalogColumn) => words(c.name).some((w) => DISTANCE_UNIT.has(w));

/**
 * Whether a column reads as a duration and, when it does, how many of its
 * unit make an hour (null when the name does not say the unit).
 */
function durationOf(column: CatalogColumn): { perHour: number | null } | null {
  const w = words(column.name);
  const unit = DURATION_UNIT.get(w[w.length - 1] ?? "");
  if (unit !== undefined && w.some((x) => TIME_WORD.includes(x)))
    return { perHour: unit };
  const found = w.filter((x) => DURATION_WORD.has(x));
  if (found.length === 0) return null;
  // `duration_seconds`: the word that says the unit, over the one that does not.
  const known = found.map((x) => DURATION_WORD.get(x)).find((f) => typeof f === "number");
  return { perHour: known ?? null };
}

const isDuration = (c: CatalogColumn) => durationOf(c) !== null;

/* -------------------------------------------------------------------------- */
/* The recognizers                                                            */
/* -------------------------------------------------------------------------- */

/** What the three recognizers produce, in order of specificity. */
export const FILE_STARTERS = ["activity", "spending", "measurements"] as const;
export type FileStarter = (typeof FILE_STARTERS)[number];

/** The columns a recognized table's dashboard is built from. */
export type Recognized =
  | {
      starter: "activity";
      distance: CatalogColumn;
      duration: CatalogColumn;
      type?: CatalogColumn;
      heart?: CatalogColumn;
    }
  | {
      starter: "spending";
      money: CatalogColumn;
      category: CatalogColumn;
      merchant?: CatalogColumn;
    }
  | { starter: "measurements"; measures: CatalogColumn[] };

function activity(shape: Shape): Recognized | null {
  const distance = shape.numbers.find(isDistance);
  const duration = shape.numbers.find((c) => c !== distance && isDuration(c));
  if (!distance || !duration) return null;
  const heart = shape.numbers.find((c) => hasWord(c, HEART));
  const type = byPreference(shape.texts, ACTIVITY_TYPE);
  return {
    starter: "activity",
    distance,
    duration,
    ...(type ? { type } : {}),
    ...(heart ? { heart } : {}),
  };
}

function spending(shape: Shape): Recognized | null {
  const money = shape.numbers.find((c) => hasWord(c, MONEY));
  if (!money) return null;
  const merchant = byPreference(shape.texts, MERCHANT);
  const category =
    byPreference(
      shape.texts.filter((c) => c !== merchant),
      CATEGORY,
    ) ?? merchant;
  // Money with nothing to break it down by is a measure, not spending.
  if (!category) return null;
  return {
    starter: "spending",
    money,
    category,
    ...(merchant && merchant !== category ? { merchant } : {}),
  };
}

function measurements(shape: Shape): Recognized | null {
  if (shape.numbers.length < 2) return null;
  // A distance or a duration without its other half is half an activity
  // log, which a daily average would misread: no starter rather than a
  // wrong one.
  if (shape.numbers.some((c) => isDistance(c) || isDuration(c))) return null;
  return { starter: "measurements", measures: shape.numbers.slice(0, MAX_MEASURES) };
}

/**
 * Which starter a table gets, and from which columns, or null. The most
 * specific recognizer that matches wins; a table gets one starter at most.
 */
export function recognizeTable(table: CatalogTable): Recognized | null {
  const shape = shapeOf(table);
  if (!shape) return null;
  return activity(shape) ?? spending(shape) ?? measurements(shape);
}

/* -------------------------------------------------------------------------- */
/* The dashboards                                                             */
/* -------------------------------------------------------------------------- */

/** A panel before it is placed: its size, and everything else it says. */
type Unplaced = Omit<Panel, "layout"> & { w: number; h: number };

/**
 * Left to right, wrapping at the grid's twelve columns; a row is as tall as
 * its tallest panel.
 */
function flow(panels: Unplaced[]): Panel[] {
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  return panels.map(({ w, h, ...panel }) => {
    if (x + w > 12) {
      x = 0;
      y += rowHeight;
      rowHeight = 0;
    }
    const placed = { ...panel, layout: { x, y, w, h } } as Panel;
    x += w;
    rowHeight = Math.max(rowHeight, h);
    return placed;
  });
}

const WHOLE_TABLE =
  "It reads the whole table: a breakdown has no time for the window to narrow.";

function spendingPanels(
  shape: Shape,
  r: Extract<Recognized, { starter: "spending" }>,
  sourceId: string,
): Unplaced[] {
  const { table: from, time } = shape;
  const money = r.money.name;
  const category = r.category.name;
  const two = { decimals: 2 };
  const panels: Unplaced[] = [
    {
      id: "per-week",
      title: "Spent per week",
      description: `The sum of ${money} in ${from}, week by week.`,
      viz: "bar",
      format: "number",
      options: two,
      query: {
        sourceId,
        timeField: "bucket",
        sql: `SELECT date_trunc('week', ${time}) AS bucket, sum(${money}) AS spent\nFROM ${from}\nGROUP BY 1\nORDER BY bucket`,
      },
      w: 8,
      h: 4,
    },
    {
      id: "latest-month",
      title: "Spent in the latest month",
      description: `The sum of ${money} in the most recent month in the window, with every month behind it.`,
      viz: "stat",
      format: "number",
      options: { ...two, value: "spent", sparkline: true },
      query: {
        sourceId,
        timeField: "bucket",
        sql: `SELECT date_trunc('month', ${time}) AS bucket, sum(${money}) AS spent\nFROM ${from}\nGROUP BY 1\nORDER BY bucket`,
      },
      w: 4,
      h: 4,
    },
    {
      id: "by-category",
      title: `Spent by ${category}`,
      description: `The sum of ${money} per ${category}. ${WHOLE_TABLE}`,
      viz: "pie",
      format: "number",
      options: two,
      query: {
        sourceId,
        sql: `SELECT ${category}, sum(${money}) AS spent\nFROM ${from}\nGROUP BY 1\nORDER BY spent DESC`,
      },
      w: 6,
      h: 5,
    },
  ];
  if (r.merchant) {
    const merchant = r.merchant.name;
    panels.push({
      id: "top-merchants",
      title: `Top ${merchant}s`,
      description: `The ten ${merchant}s with the most ${money}, and how many payments each. ${WHOLE_TABLE}`,
      viz: "table",
      options: {
        limit: 10,
        columns: [{ name: "spent", decimals: 2, align: "right" }],
      },
      query: {
        sourceId,
        sql: `SELECT ${merchant}, sum(${money}) AS spent, count(*) AS payments\nFROM ${from}\nGROUP BY 1\nORDER BY spent DESC`,
      },
      w: 6,
      h: 5,
    });
  }
  panels.push({
    id: "by-month",
    title: `Month by month, by ${category}`,
    description: `The sum of ${money} and the number of payments per month and ${category}, newest first.`,
    viz: "table",
    options: { columns: [{ name: "spent", decimals: 2, align: "right" }] },
    query: {
      sourceId,
      timeField: "bucket",
      sql: `SELECT date_trunc('month', ${time}) AS bucket, ${category}, sum(${money}) AS spent, count(*) AS payments\nFROM ${from}\nGROUP BY 1, 2\nORDER BY bucket DESC, spent DESC`,
    },
    w: 12,
    h: 5,
  });
  return panels;
}

function activityPanels(
  shape: Shape,
  r: Extract<Recognized, { starter: "activity" }>,
  sourceId: string,
): Unplaced[] {
  const { table: from, time } = shape;
  const distance = r.distance.name;
  const duration = r.duration.name;
  const unit = distanceUnit(r.distance);
  const factor = durationOf(r.duration)?.perHour ?? null;
  // Distance per hour when the duration's unit is known, else per its unit.
  const speed =
    factor === null
      ? `sum(${distance}) / nullif(sum(${duration}), 0)`
      : `sum(${distance}) * ${factor}.0 / nullif(sum(${duration}), 0)`;
  const speedUnit = unit && factor !== null ? `${unit}/h` : undefined;
  const series = (id: string, column: string, title: string): Unplaced => ({
    id,
    title,
    description: `The sum of ${column} in ${from}, week by week.`,
    viz: "bar",
    format: "number",
    query: {
      sourceId,
      timeField: "bucket",
      sql: `SELECT date_trunc('week', ${time}) AS bucket, sum(${column}) AS ${column}\nFROM ${from}\nGROUP BY 1\nORDER BY bucket`,
    },
    w: 6,
    h: 4,
  });
  const panels: Unplaced[] = [
    series("distance-per-week", distance, "Distance per week"),
    series("duration-per-week", duration, "Time per week"),
    {
      id: "speed",
      title: "Average speed per week",
      description: `${distance} over ${duration}, week by week${speedUnit ? `, in ${speedUnit}` : ""}.`,
      viz: "line",
      format: "number",
      options: { decimals: 1, ...(speedUnit ? { unit: speedUnit } : {}) },
      query: {
        sourceId,
        timeField: "bucket",
        sql: `SELECT date_trunc('week', ${time}) AS bucket, ${speed} AS speed\nFROM ${from}\nGROUP BY 1\nORDER BY bucket`,
      },
      w: 6,
      h: 4,
    },
  ];
  if (r.heart) {
    const heart = r.heart.name;
    panels.push({
      id: "heart-rate",
      title: `Average ${heart} per week`,
      description: `The average of ${heart} in ${from}, week by week.`,
      viz: "line",
      format: "number",
      options: { decimals: 0 },
      query: {
        sourceId,
        timeField: "bucket",
        sql: `SELECT date_trunc('week', ${time}) AS bucket, avg(${heart}) AS ${heart}\nFROM ${from}\nGROUP BY 1\nORDER BY bucket`,
      },
      w: 6,
      h: 4,
    });
  }
  if (r.type) {
    const type = r.type.name;
    panels.push({
      id: "by-type",
      title: `Activities by ${type}`,
      description: `How many rows of ${from} per ${type}. ${WHOLE_TABLE}`,
      viz: "pie",
      format: "number",
      query: {
        sourceId,
        sql: `SELECT ${type}, count(*) AS activities\nFROM ${from}\nGROUP BY 1\nORDER BY activities DESC`,
      },
      w: 6,
      h: 4,
    });
  }
  const listed = [time, r.type?.name, distance, duration, r.heart?.name].filter(
    (c): c is string => c !== undefined,
  );
  panels.push({
    id: "recent",
    title: "Recent activities",
    description: `The latest rows of ${from}, newest first.`,
    viz: "table",
    options: { limit: 20 },
    query: {
      sourceId,
      timeField: time,
      sql: `SELECT ${listed.join(", ")}\nFROM ${from}\nORDER BY ${time} DESC`,
    },
    w: 12,
    h: 5,
  });
  return panels;
}

function measurementPanels(
  shape: Shape,
  r: Extract<Recognized, { starter: "measurements" }>,
  sourceId: string,
): Unplaced[] {
  const { table: from, time } = shape;
  const daily = (column: string) =>
    `SELECT date_trunc('day', ${time}) AS bucket, avg(${column}) AS ${column}\nFROM ${from}\nGROUP BY 1\nORDER BY bucket`;
  const statWidth = Math.floor(12 / r.measures.length);
  const stats: Unplaced[] = r.measures.map((m, i) => ({
    id: `latest-${i + 1}`,
    title: `Latest ${m.name}`,
    description: `The most recent day's ${m.name} in the window, with the days before it.`,
    viz: "stat",
    format: "number",
    options: { value: m.name, sparkline: true },
    query: { sourceId, timeField: "bucket", sql: daily(m.name) },
    w: statWidth,
    h: 3,
  }));
  const lines: Unplaced[] = r.measures.map((m, i) => ({
    id: `daily-${i + 1}`,
    title: `${m.name} per day`,
    description: `The daily average of ${m.name} in ${from}.`,
    viz: "line",
    format: "number",
    query: { sourceId, timeField: "bucket", sql: daily(m.name) },
    w: 6,
    h: 4,
  }));
  const columns = [time, ...r.measures.map((m) => m.name)];
  return [
    ...stats,
    ...lines,
    {
      id: "recent",
      title: "Latest rows",
      description: `The latest rows of ${from}, newest first.`,
      viz: "table",
      options: { limit: 20 },
      query: {
        sourceId,
        timeField: time,
        sql: `SELECT ${columns.join(", ")}\nFROM ${from}\nORDER BY ${time} DESC`,
      },
      w: 12,
      h: 5,
    },
  ];
}

/** What each starter is called in the picker, and the sentence under it. */
function naming(shape: Shape, r: Recognized): { label: string; description: string } {
  switch (r.starter) {
    case "spending":
      return {
        label: "Spending",
        description: `Spending week by week, by ${r.category.name}${r.merchant ? `, the top ${r.merchant.name}s` : ""} and month by month, from ${shape.table}'s ${shape.time} and ${r.money.name}.`,
      };
    case "activity":
      return {
        label: "Activity log",
        description: `Distance, time and speed week by week${r.type ? `, by ${r.type.name}` : ""}, and the latest activities, from ${shape.table}'s ${r.distance.name} and ${r.duration.name}.`,
      };
    case "measurements":
      return {
        label: "Daily measurements",
        description: `The latest value and a daily series for ${r.measures.map((m) => m.name).join(", ")}, from ${shape.table}.`,
      };
  }
}

function panelsFor(shape: Shape, r: Recognized, sourceId: string): Unplaced[] {
  switch (r.starter) {
    case "spending":
      return spendingPanels(shape, r, sourceId);
    case "activity":
      return activityPanels(shape, r, sourceId);
    case "measurements":
      return measurementPanels(shape, r, sourceId);
  }
}

/**
 * The file starters for one source: one dashboard template per recognized
 * table, in catalog order, at most {@link MAX_TABLES}. Panel templates are
 * not offered; a starter is a whole dashboard or nothing.
 *
 * Deterministic: the same catalog always produces the same list in the same
 * order, and no model is asked anything.
 */
export function buildFileTemplates(
  source: CatalogSubject,
  kind?: TemplateKind,
): Template[] {
  if (kind === "panel") return [];
  const out: Template[] = [];
  for (const table of exposedCatalogTables(source)) {
    if (out.length >= MAX_TABLES) break;
    const shape = shapeOf(table);
    const recognized = shape ? recognizeTable(table) : null;
    if (!shape || !recognized) continue;
    const { label, description } = naming(shape, recognized);
    const name = `${label} — ${shape.table}`;
    const dashboard: Dashboard = {
      specVersion: SPEC_VERSION,
      title: name,
      timeRange: FILE_TIME_RANGE,
      refreshIntervalMs: FILE_REFRESH_MS,
      panels: flow(panelsFor(shape, recognized, source.id)),
    };
    out.push({
      id: `builtin:${source.id}:${shape.table}:${recognized.starter}`,
      origin: "builtin",
      kind: "dashboard",
      recognized: true,
      name,
      description,
      body: { kind: "dashboard", dashboard },
    });
  }
  return out;
}
