import { type FileHandle, open } from "node:fs/promises";
import { join, posix } from "node:path";
import { SaxesParser } from "saxes";
import { type CsvCell, type CsvDate, csvHeader, csvRow } from "@/lib/csv-writer";
import {
  readZipDirectory,
  readZipEntry,
  ZipError,
  type ZipEntry,
} from "@/lib/duckdb/zip";

/**
 * An uploaded Excel workbook (`.xlsx`), converted to one CSV per sheet (#597).
 *
 * DuckDB's `excel` extension is not bundled with the binding and cannot be
 * loaded under the locked engine, so a workbook is read here, in Node, and
 * the upload's directory gets CSVs the engine already reads. The workbook is
 * an Office Open XML package: a ZIP archive ({@link readZipDirectory}) of XML
 * parts, each streamed through a SAX parser (`saxes`, which expands no
 * entity it was not born with, so no external or recursive entity), never
 * held whole except the shared strings and styles a sheet's cells point
 * into, and those under {@link MAX_HELD_PART_BYTES}.
 *
 * Each visible sheet is read twice: once to count its rows and find its
 * width and whether it is empty, so every cap and every name is decided
 * before anything is written, then once to write its CSV. Cells are typed
 * as Excel stores them: a number, a boolean, text (shared or inline), a
 * formula's cached value, an error (written empty), and a number whose
 * format is a date or a time written as an ISO 8601 date in UTC.
 */

/** A workbook that cannot be converted. Its message names a sheet, never a path. */
export class WorkbookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookError";
  }
}

/** The bounds a conversion is held to. */
export interface WorkbookLimits {
  /** The most sheets one workbook may turn into tables. */
  maxSheets: number;
  /** The most rows (the header included) one sheet may hold. */
  maxRows: number;
  /** The most bytes the CSVs of one workbook may come to together. */
  maxBytes: number;
}

/**
 * The most a sheet's XML may inflate to, read as a stream: a backstop on
 * the work one part can ask for, beyond the row and byte caps.
 */
export const MAX_SHEET_PART_BYTES = 1024 * 1024 * 1024;

/**
 * The most the parts held in memory (the workbook, its relationships, its
 * shared strings and its styles) may each inflate to.
 */
export const MAX_HELD_PART_BYTES = 128 * 1024 * 1024;

/** The longest view name a sheet makes; the same as an uploaded file's. */
const MAX_VIEW_NAME = 64;

/** One sheet that became a table. */
export interface ConvertedSheet {
  sheet: string;
  view: string;
  rows: number;
  bytes: number;
}

/** One sheet that did not, and why. */
export interface SkippedSheet {
  sheet: string;
  reason: "hidden" | "empty";
}

/**
 * The view a sheet of a workbook with several sheets becomes, or null when
 * the sheet's name has nothing left: `<stem>_<sheet>`, the sheet's name
 * lowercased with every run of anything but `[a-z0-9_]` made one `_` and
 * trimmed of `_`, cut to the same length an uploaded file's name is.
 */
export function sheetViewName(stem: string, sheet: string): string | null {
  const reduced = sheet
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!reduced) return null;
  return `${stem}_${reduced}`.slice(0, MAX_VIEW_NAME).replace(/_+$/, "");
}

/* -------------------------------------------------------------------------- */
/* Number formats                                                             */
/* -------------------------------------------------------------------------- */

type DateShow = CsvDate["show"];

/** Excel's built-in number formats that are dates or times, by id. */
const BUILTIN_DATE_FORMATS: Record<number, DateShow> = {
  14: "date",
  15: "date",
  16: "date",
  17: "date",
  18: "time",
  19: "time",
  20: "time",
  21: "time",
  22: "datetime",
  45: "time",
  46: "time",
  47: "time",
};
// The East Asian locales' built-in date formats.
for (const id of [27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]) {
  BUILTIN_DATE_FORMATS[id] = "date";
}
for (const id of [32, 33, 55, 56]) BUILTIN_DATE_FORMATS[id] = "time";

/**
 * Whether a custom number format shows a date, a date and time, or a time,
 * or null for anything else. Only the first section counts; quoted text,
 * escapes, colors and conditions are not tokens. An elapsed time (`[h]:mm`)
 * is a duration, left a number.
 */
export function formatShows(code: string): DateShow | null {
  const first = code.split(";")[0] ?? "";
  if (/\[(h+|m+|s+)\]/i.test(first)) return null;
  const tokens = first
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/[_*]./g, "")
    .replace(/\[[^\]]*\]/g, "")
    .replace(/general/gi, "")
    .replace(/am\/pm|a\/p/gi, "h");
  const time = /[hs]/i.test(tokens);
  const date = /[dy]/i.test(tokens) || (/m/i.test(tokens) && !time);
  if (date && time) return "datetime";
  if (date) return "date";
  if (time) return "time";
  return null;
}

/* -------------------------------------------------------------------------- */
/* Reading parts                                                              */
/* -------------------------------------------------------------------------- */

interface XmlHandlers {
  open?(name: string, attrs: Record<string, string>): void;
  close?(name: string): void;
  text?(text: string): void;
  /** Awaited after each chunk of the part has been parsed. */
  drain?(): Promise<void>;
}

/** An element or attribute name without its namespace prefix. */
const local = (name: string) => name.slice(name.indexOf(":") + 1);

/** Stream one part's XML through a SAX parser. */
async function readXml(
  file: string,
  entry: ZipEntry,
  maxBytes: number,
  handlers: XmlHandlers,
): Promise<void> {
  const parser = new SaxesParser({ xmlns: false });
  const decoder = new TextDecoder("utf-8");
  if (handlers.open) {
    const open = handlers.open;
    parser.on("opentag", (tag) =>
      open(local(tag.name), tag.attributes as Record<string, string>),
    );
  }
  if (handlers.close) {
    const close = handlers.close;
    parser.on("closetag", (tag) => close(local(tag.name)));
  }
  if (handlers.text) {
    parser.on("text", handlers.text);
    parser.on("cdata", handlers.text);
  }
  try {
    await readZipEntry(file, entry, maxBytes, async (chunk) => {
      parser.write(decoder.decode(chunk, { stream: true }));
      await handlers.drain?.();
    });
    parser.write(decoder.decode());
    parser.close();
  } catch (err) {
    if (err instanceof WorkbookError || err instanceof ZipError) throw err;
    // A SAX error quotes a line and column of the part; that is all it says.
    throw new WorkbookError("a part of it is not well-formed XML");
  }
}

/** A relationship part: its targets by id, with their types. */
async function readRels(
  file: string,
  entries: Map<string, ZipEntry>,
  part: string,
): Promise<Map<string, { type: string; target: string }>> {
  const rels = new Map<string, { type: string; target: string }>();
  const entry = entries.get(part);
  if (!entry) return rels;
  const base = posix.dirname(posix.dirname(part));
  await readXml(file, entry, MAX_HELD_PART_BYTES, {
    open(name, attrs) {
      if (name !== "Relationship" || attrs.TargetMode === "External") return;
      const id = attrs.Id;
      const target = attrs.Target;
      if (!id || !target) return;
      rels.set(id, { type: attrs.Type ?? "", target: resolveTarget(base, target) });
    },
  });
  return rels;
}

/** A relationship's target as an entry name: absolute from the package root, or relative to `base`. */
function resolveTarget(base: string, target: string): string {
  const joined = target.startsWith("/")
    ? target.slice(1)
    : posix.join(base === "." ? "" : base, target);
  return posix.normalize(joined).replace(/^(\.\.\/)+/, "");
}

const ofType = (type: string, suffix: string) => type.endsWith(`/${suffix}`);

interface SheetRef {
  name: string;
  part: string | null;
  hidden: boolean;
}

interface Book {
  sheets: SheetRef[];
  date1904: boolean;
  shared: string[];
  /** Per cell style index, the date it shows, or null. */
  styles: (DateShow | null)[];
}

async function readBook(file: string, entries: Map<string, ZipEntry>): Promise<Book> {
  const root = await readRels(file, entries, "_rels/.rels");
  const office = [...root.values()].find((r) => ofType(r.type, "officeDocument"));
  const workbookPart = office?.target ?? "xl/workbook.xml";
  const workbookEntry = entries.get(workbookPart);
  if (!workbookEntry) throw new WorkbookError("it is not an Excel workbook");
  const relsPart = posix.join(
    posix.dirname(workbookPart),
    "_rels",
    `${posix.basename(workbookPart)}.rels`,
  );
  const rels = await readRels(file, entries, relsPart);

  const listed: { name: string; rid: string; hidden: boolean }[] = [];
  let date1904 = false;
  await readXml(file, workbookEntry, MAX_HELD_PART_BYTES, {
    open(name, attrs) {
      if (name === "workbookPr") {
        date1904 = attrs.date1904 === "1" || attrs.date1904 === "true";
      } else if (name === "sheet") {
        const rid = Object.entries(attrs).find(([k]) => /^(?:[^:]+:)?id$/.test(k))?.[1];
        listed.push({
          name: attrs.name ?? "",
          rid: rid ?? "",
          hidden: attrs.state === "hidden" || attrs.state === "veryHidden",
        });
      }
    },
  });
  const sheets = listed.map((s) => {
    const rel = rels.get(s.rid);
    return {
      name: s.name,
      hidden: s.hidden,
      part: rel && ofType(rel.type, "worksheet") ? rel.target : null,
    };
  });

  const relList = [...rels.values()];
  const sharedPart = relList.find((r) => ofType(r.type, "sharedStrings"))?.target;
  const stylesPart = relList.find((r) => ofType(r.type, "styles"))?.target;
  const shared = sharedPart ? await readShared(file, entries, sharedPart) : [];
  const styles = stylesPart ? await readStyles(file, entries, stylesPart) : [];
  return { sheets, date1904, shared, styles };
}

/** The shared strings: each `<si>`'s text, its runs joined, phonetic hints left out. */
async function readShared(
  file: string,
  entries: Map<string, ZipEntry>,
  part: string,
): Promise<string[]> {
  const entry = entries.get(part);
  if (!entry) return [];
  const strings: string[] = [];
  let current: string | null = null;
  let inText = false;
  let phonetic = 0;
  await readXml(file, entry, MAX_HELD_PART_BYTES, {
    open(name) {
      if (name === "si") current = "";
      else if (name === "rPh") phonetic++;
      else if (name === "t" && current !== null && phonetic === 0) inText = true;
    },
    close(name) {
      if (name === "si") {
        strings.push(current ?? "");
        current = null;
      } else if (name === "rPh") phonetic--;
      else if (name === "t") inText = false;
    },
    text(text) {
      if (inText && current !== null) current += text;
    },
  });
  return strings;
}

/** Per cell style (`cellXfs`), whether its number format shows a date or a time. */
async function readStyles(
  file: string,
  entries: Map<string, ZipEntry>,
  part: string,
): Promise<(DateShow | null)[]> {
  const entry = entries.get(part);
  if (!entry) return [];
  const custom = new Map<number, string>();
  const formats: number[] = [];
  let inCellXfs = false;
  await readXml(file, entry, MAX_HELD_PART_BYTES, {
    open(name, attrs) {
      if (name === "numFmt") {
        custom.set(Number(attrs.numFmtId), attrs.formatCode ?? "");
      } else if (name === "cellXfs") {
        inCellXfs = true;
      } else if (name === "xf" && inCellXfs) {
        formats.push(Number(attrs.numFmtId ?? 0));
      }
    },
    close(name) {
      if (name === "cellXfs") inCellXfs = false;
    },
  });
  return formats.map((id) => {
    const code = custom.get(id);
    if (code !== undefined) return formatShows(code);
    return BUILTIN_DATE_FORMATS[id] ?? null;
  });
}

/* -------------------------------------------------------------------------- */
/* Cells                                                                      */
/* -------------------------------------------------------------------------- */

const DAY_MS = 86_400_000;

/**
 * An Excel date serial as a UTC instant, to the second, or null when it is
 * not a date Excel can show. The 1900 system counts from 1899-12-31 and has
 * a 29 February 1900 that never was (serial 60), so from serial 61 it counts
 * from 1899-12-30; the 1904 system counts from 1904-01-01.
 */
export function excelSerialToMs(serial: number, date1904: boolean): number | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return null;
  const epoch = date1904
    ? Date.UTC(1904, 0, 1)
    : serial < 61
      ? Date.UTC(1899, 11, 31)
      : Date.UTC(1899, 11, 30);
  return Math.round((epoch + serial * DAY_MS) / 1000) * 1000;
}

/** A column's index from a cell reference (`C12` is 2), or -1. */
function columnOf(ref: string): number {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const code = ref.charCodeAt(i);
    if (code >= 65 && code <= 90) col = col * 26 + (code - 64);
    else if (code >= 97 && code <= 122) col = col * 26 + (code - 96);
    else break;
  }
  return i === 0 || col > 16_384 ? -1 : col - 1;
}

/** One cell's value, from its type, its style and the text read for it. */
function cellValue(
  book: Book,
  type: string,
  style: number,
  value: string,
  inline: string,
  hasValue: boolean,
): CsvCell {
  switch (type) {
    case "s": {
      const text = book.shared[Number(value)];
      return text === undefined ? null : text;
    }
    case "str":
      return hasValue ? value : null;
    case "inlineStr":
      return inline;
    case "b":
      return hasValue ? value.trim() === "1" || value.trim() === "true" : null;
    case "e":
      return null;
    case "d": {
      const ms = Date.parse(value.trim().endsWith("Z") ? value : `${value.trim()}Z`);
      if (!Number.isFinite(ms)) return hasValue ? value : null;
      return {
        ms: Math.round(ms / 1000) * 1000,
        show: value.includes("T") ? "datetime" : "date",
      };
    }
    default: {
      if (!hasValue || value.trim() === "") return null;
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      const show = book.styles[style] ?? null;
      if (show) {
        const ms = excelSerialToMs(n, book.date1904);
        if (ms !== null)
          return { ms, show: show === "time" && n >= 1 ? "datetime" : show };
      }
      return n;
    }
  }
}

/**
 * Read one sheet's rows, handing each row that holds anything to `onRow`
 * with its cells by column. An entirely empty row is passed over.
 */
async function readSheet(
  file: string,
  entry: ZipEntry,
  book: Book,
  onRow: (cells: CsvCell[]) => void,
  drain?: () => Promise<void>,
): Promise<void> {
  let inData = false;
  let row: CsvCell[] | null = null;
  let filled = false;
  let col = -1;
  let type = "n";
  let style = 0;
  let value = "";
  let inline = "";
  let hasValue = false;
  let inValue = false;
  let inInline = false;
  let inInlineText = false;
  let phonetic = 0;
  await readXml(file, entry, MAX_SHEET_PART_BYTES, {
    open(name, attrs) {
      if (name === "sheetData") inData = true;
      if (!inData) return;
      if (name === "row") {
        row = [];
        filled = false;
        col = -1;
      } else if (name === "c" && row) {
        const at = attrs.r ? columnOf(attrs.r) : -1;
        col = at >= 0 ? at : col + 1;
        type = attrs.t ?? "n";
        style = Number(attrs.s ?? 0);
        value = "";
        inline = "";
        hasValue = false;
      } else if (name === "v") {
        inValue = true;
        hasValue = true;
      } else if (name === "is") {
        inInline = true;
      } else if (name === "rPh") {
        phonetic++;
      } else if (name === "t" && inInline && phonetic === 0) {
        inInlineText = true;
      }
    },
    close(name) {
      if (name === "sheetData") inData = false;
      else if (name === "v") inValue = false;
      else if (name === "is") inInline = false;
      else if (name === "rPh") phonetic--;
      else if (name === "t") inInlineText = false;
      else if (name === "c" && row) {
        const cell = cellValue(book, type, style, value, inline, hasValue);
        if (cell !== null && !(typeof cell === "string" && cell === "")) {
          row[col] = cell;
          filled = true;
        }
      } else if (name === "row" && row) {
        if (filled) onRow(row);
        row = null;
      }
    },
    text(text) {
      if (inValue) value += text;
      else if (inInlineText) inline += text;
    },
    drain,
  });
}

/* -------------------------------------------------------------------------- */
/* Converting                                                                 */
/* -------------------------------------------------------------------------- */

/** How much is written to the CSV at a time. */
const WRITE_CHUNK = 64 * 1024;

/**
 * Convert the workbook at `file` into one `<view>.csv` per visible sheet
 * that holds anything, in `dir`. `stem` is the workbook's own table name,
 * which a one-sheet workbook's view takes; `taken` holds the table names the
 * rest of the upload already has. Throws a {@link WorkbookError} naming the
 * sheet when a cap or a name refuses it; the caller removes what was written.
 */
export async function convertWorkbook(input: {
  file: string;
  dir: string;
  stem: string;
  taken: ReadonlySet<string>;
  limits: WorkbookLimits;
}): Promise<{ views: ConvertedSheet[]; skipped: SkippedSheet[] }> {
  const { file, dir, stem, taken, limits } = input;
  let entries: Map<string, ZipEntry>;
  try {
    entries = await readZipDirectory(file);
  } catch (err) {
    throw asWorkbookError(err);
  }
  try {
    const book = await readBook(file, entries);
    const skipped: SkippedSheet[] = [];
    const found: { sheet: string; entry: ZipEntry; width: number; rows: number }[] = [];

    for (const sheet of book.sheets) {
      if (sheet.hidden) {
        skipped.push({ sheet: sheet.name, reason: "hidden" });
        continue;
      }
      // A chart sheet or a dialog sheet holds no cells: nothing to convert.
      const entry = sheet.part ? entries.get(sheet.part) : undefined;
      if (!entry) {
        skipped.push({ sheet: sheet.name, reason: "empty" });
        continue;
      }
      let rows = 0;
      let width = 0;
      await readSheet(file, entry, book, (cells) => {
        rows++;
        if (rows > limits.maxRows) {
          throw new WorkbookError(
            `sheet "${sheet.name}" has more than ${limits.maxRows} rows`,
          );
        }
        width = Math.max(width, cells.length);
      });
      if (rows === 0) {
        skipped.push({ sheet: sheet.name, reason: "empty" });
        continue;
      }
      if (found.length >= limits.maxSheets) {
        throw new WorkbookError(
          `sheet "${sheet.name}" is past the ${limits.maxSheets} sheets a workbook may turn into tables`,
        );
      }
      found.push({ sheet: sheet.name, entry, width, rows });
    }
    if (found.length === 0) throw new WorkbookError("it has no sheet with data");

    // Every name is decided before anything is written.
    const names = new Map<string, string>();
    const views = found.map((f) => {
      const view = found.length === 1 ? stem : sheetViewName(stem, f.sheet);
      if (!view) {
        throw new WorkbookError(
          `sheet "${f.sheet}" has no name left once reduced to letters, digits and _`,
        );
      }
      const other = names.get(view);
      if (other !== undefined) {
        throw new WorkbookError(
          `sheets "${other}" and "${f.sheet}" would both be the table "${view}"; rename one`,
        );
      }
      if (found.length > 1 && taken.has(view)) {
        throw new WorkbookError(
          `sheet "${f.sheet}" would be the table "${view}", which another file in this upload already is; rename one`,
        );
      }
      names.set(view, f.sheet);
      return { ...f, view };
    });

    let total = 0;
    const converted: ConvertedSheet[] = [];
    for (const v of views) {
      const bytes = await writeSheet(file, book, v, dir, (n) => {
        total += n;
        if (total > limits.maxBytes) {
          throw new WorkbookError(
            `sheet "${v.sheet}" takes its CSVs past ${limits.maxBytes} bytes (DUCKDB_UPLOAD_MAX_BYTES)`,
          );
        }
      });
      converted.push({ sheet: v.sheet, view: v.view, rows: v.rows - 1, bytes });
    }
    return { views: converted, skipped };
  } catch (err) {
    throw asWorkbookError(err);
  }
}

function asWorkbookError(err: unknown): unknown {
  if (err instanceof ZipError) {
    return new WorkbookError(
      `it is not an .xlsx workbook that can be read: ${err.message}`,
    );
  }
  return err;
}

/** Write one sheet's CSV: the header, then every row, padded to the sheet's width. */
async function writeSheet(
  file: string,
  book: Book,
  sheet: { entry: ZipEntry; width: number; view: string },
  dir: string,
  count: (bytes: number) => void,
): Promise<number> {
  let handle: FileHandle | null = null;
  let bytes = 0;
  let pending: string[] = [];
  let pendingLength = 0;
  const flush = async () => {
    if (pending.length === 0) return;
    const chunk = Buffer.from(pending.join(""), "utf8");
    pending = [];
    pendingLength = 0;
    await handle?.write(chunk);
  };
  try {
    // A name built from a reduced view name, under the upload's own directory.
    handle = await open(
      join(/* turbopackIgnore: true */ dir, `${sheet.view}.csv`),
      "wx",
      0o640,
    );
    let header = true;
    // Rows arrive as each chunk of the part is parsed; they are written once
    // a chunk's worth has gathered, so a sheet is never held whole.
    await readSheet(
      file,
      sheet.entry,
      book,
      (cells) => {
        const line = header ? csvHeader(cells, sheet.width) : csvRow(cells, sheet.width);
        header = false;
        const size = Buffer.byteLength(line, "utf8");
        bytes += size;
        count(size);
        pending.push(line);
        pendingLength += size;
      },
      async () => {
        if (pendingLength >= WRITE_CHUNK) await flush();
      },
    );
    await flush();
  } finally {
    await handle?.close();
  }
  return bytes;
}
