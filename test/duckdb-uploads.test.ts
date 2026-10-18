import { after, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { config } from "@/lib/config";
import {
  MAX_SHEET_ROWS,
  MAX_WORKBOOK_SHEETS,
  receiveUpload,
  removeUpload,
  STAGING_PREFIX,
  sweepOrphanedUploads,
  UPLOAD_ORPHAN_AGE_MS,
  textProblem,
  UploadError,
  uploadExtension,
  uploadsAvailability,
  uploadStem,
} from "@/lib/duckdb/uploads";
import { readerFor } from "@/lib/duckdb/client";
import { excelSerialToMs, formatShows, sheetViewName } from "@/lib/duckdb/workbook";
import {
  duckdb,
  isUploadPath,
  spreadsheetProblem,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  WORKBOOK_EXTENSION,
} from "@/lib/sources/kinds/duckdb";
import { DuckDbPathError, SOURCES_DIR_UNSET } from "@/lib/duckdb/path";
import { createLogger, setLogger } from "@/lib/log";
import type { SourceRecord } from "@/lib/registry";
import {
  MultipartError,
  multipartBoundary,
  type PartSink,
  readMultipart,
} from "@/lib/multipart";

/**
 * Uploads from the browser as a DuckDB source (#595): the multipart reader
 * (a parser of untrusted input), and the rules an upload is held to: the
 * byte and file caps, the text check, the stem rules, the stored extension
 * that picks the reader (#596), all-or-nothing on
 * every refusal and on a cancelled request, messages that name no server
 * path, and that only an upload directory is ever removed. And an Excel
 * workbook (#597): an untrusted ZIP of XML converted to one CSV per sheet,
 * its naming, its cell rules and its caps.
 */

const writable = config as { duckdbUploadMaxBytes: number; duckdbUploadMaxFiles: number };
const saved = {
  duckdbUploadMaxBytes: writable.duckdbUploadMaxBytes,
  duckdbUploadMaxFiles: writable.duckdbUploadMaxFiles,
};
after(() => Object.assign(writable, saved));

const BOUNDARY = "----holotable-test-boundary";

function root(): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "holotable-uploads-")));
  mkdirSync(join(base, "root"));
  return join(base, "root");
}

type FilePart = { name: string; body: string | Uint8Array; field?: string };

function multipart(files: FilePart[]): Uint8Array {
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(
      Buffer.from(
        `--${BOUNDARY}\r\nContent-Disposition: form-data; name="${f.field ?? "files"}"; filename="${f.name}"\r\nContent-Type: text/csv\r\n\r\n`,
      ),
    );
    chunks.push(Buffer.from(f.body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

/** A body delivered `size` bytes at a time, so every split is exercised. */
function stream(
  bytes: Uint8Array,
  size = 7,
  stopAfter?: number,
): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (stopAfter !== undefined && offset >= stopAfter) {
        controller.error(new Error("aborted by the browser"));
        return;
      }
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
}

type UploadOptions = {
  size?: number;
  stopAfter?: number;
  workbookCaps?: { maxSheets?: number; maxRows?: number };
};

const upload = (dir: string, files: FilePart[], opts: UploadOptions = {}) =>
  receiveUpload({
    workspaceId: "ops",
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    body: stream(multipart(files), opts.size ?? 7, opts.stopAfter),
    root: dir,
    workbookCaps: opts.workbookCaps,
  });

/** Nothing is left under the workspace's uploads. */
function nothingKept(dir: string) {
  const ws = join(dir, "uploads", "ops");
  assert.ok(
    !existsSync(ws) || readdirSync(ws).length === 0,
    "a refused upload left files",
  );
}

async function refused(
  dir: string,
  files: FilePart[],
  message: RegExp,
  file?: string,
  opts: UploadOptions = {},
) {
  await assert.rejects(upload(dir, files, opts), (err: unknown) => {
    assert.ok(err instanceof UploadError, String(err));
    assert.match(err.message, message);
    assert.ok(!err.message.includes(dir), `a path leaked: ${err.message}`);
    if (file) assert.equal(err.file, file);
    return true;
  });
  nothingKept(dir);
}

/* -------------------------------------------------------------------------- */
/* The multipart reader                                                       */
/* -------------------------------------------------------------------------- */

async function collect(body: Uint8Array, size: number) {
  const parts: { name: string; filename: string | null; data: string }[] = [];
  await readMultipart(
    stream(body, size),
    BOUNDARY,
    async (part): Promise<PartSink> => {
      const chunks: Buffer[] = [];
      return {
        write: async (c) => void chunks.push(Buffer.from(c)),
        end: async () =>
          void parts.push({ ...part, data: Buffer.concat(chunks).toString("utf8") }),
      };
    },
    { maxParts: 10 },
  );
  return parts;
}

test("the multipart reader splits parts at their delimiters, however the body is chunked", async () => {
  // A body holding text that is nearly a delimiter, and CRLFs of its own.
  const tricky = `a,b\r\n1,2\r\n--${BOUNDARY.slice(0, -1)}x\r\n\r\n--`;
  const body = multipart([
    { name: "one.csv", body: tricky },
    { name: "two.csv", body: "" },
    { name: "Ünïcode name.csv", body: "x\n" },
  ]);
  for (const size of [1, 2, 3, 7, 64, body.length]) {
    const parts = await collect(body, size);
    assert.deepEqual(
      parts.map((p) => [p.filename, p.data]),
      [
        ["one.csv", tricky],
        ["two.csv", ""],
        ["Ünïcode name.csv", "x\n"],
      ],
      `chunk size ${size}`,
    );
  }
});

test("the multipart reader refuses a malformed, oversized or truncated body", async () => {
  const sink = async (): Promise<PartSink> => ({
    write: async () => {},
    end: async () => {},
  });
  const read = (bytes: Uint8Array, maxParts = 10) =>
    readMultipart(stream(bytes, 5), BOUNDARY, sink, { maxParts, maxHeaderBytes: 256 });
  const whole = multipart([
    { name: "a.csv", body: "x" },
    { name: "b.csv", body: "y" },
  ]);
  await assert.rejects(read(whole, 1), MultipartError);
  // Cut short: no closing delimiter.
  await assert.rejects(read(whole.slice(0, whole.length - 10)), /ended before/);
  await assert.rejects(
    read(Buffer.from("no boundary here at all".repeat(100))),
    MultipartError,
  );
  const hugeHeader = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${"a".repeat(400)}"\r\n\r\nx\r\n--${BOUNDARY}--`,
  );
  await assert.rejects(read(hugeHeader), /headers are too large/);
  const notFormData = Buffer.from(
    `--${BOUNDARY}\r\nContent-Type: text/csv\r\n\r\nx\r\n--${BOUNDARY}--`,
  );
  await assert.rejects(read(notFormData), /not form-data/);
  await assert.rejects(readMultipart(null, BOUNDARY, sink, { maxParts: 1 }), /no body/);
});

test("only multipart/form-data with a valid boundary is read", () => {
  assert.equal(multipartBoundary(`multipart/form-data; boundary=${BOUNDARY}`), BOUNDARY);
  assert.equal(multipartBoundary('multipart/form-data; boundary="a b"'), "a b");
  assert.equal(multipartBoundary("application/json"), null);
  assert.equal(multipartBoundary("multipart/form-data"), null);
  assert.equal(
    multipartBoundary(`multipart/form-data; boundary=${"x".repeat(71)}`),
    null,
  );
  assert.equal(multipartBoundary(null), null);
});

/* -------------------------------------------------------------------------- */
/* What an upload is held to                                                  */
/* -------------------------------------------------------------------------- */

test("a stem becomes an identifier, or nothing", () => {
  assert.equal(uploadStem("Bank Export (2026).csv"), "bank_export_2026");
  assert.equal(uploadStem("orders.CSV"), "orders");
  assert.equal(uploadStem("2026-sales.csv"), "t_2026_sales");
  assert.equal(uploadStem("../../etc/passwd"), "passwd");
  assert.equal(uploadStem("C:\\Users\\me\\Strava.csv"), "strava");
  assert.equal(uploadStem("données.csv"), "donn_es");
  for (const empty of [".csv", "---.csv", "().txt", "", "ñ.csv"]) {
    assert.equal(uploadStem(empty), null, empty);
  }
  assert.ok((uploadStem(`${"a".repeat(300)}.csv`) ?? "").length <= 64);
});

test("text is UTF-8 without a NUL, judged on the first chunk", () => {
  assert.equal(textProblem(Buffer.from("ts,v\n2026-01-01,1\n"), true), null);
  assert.equal(textProblem(Buffer.from("café,1\n"), true), null);
  assert.match(
    String(textProblem(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]), true)),
    /NUL/,
  );
  assert.match(String(textProblem(Buffer.from([0x61, 0xff, 0x62]), true)), /UTF-8/);
  // A character cut at the end of a chunk is not held against it, until the end.
  const cut = Buffer.from("é").subarray(0, 1);
  assert.equal(textProblem(cut, false), null);
  assert.match(String(textProblem(cut, true)), /UTF-8/);
});

test("a stored file keeps a JSON extension, so the directory reads it as JSON (#596)", () => {
  assert.equal(uploadExtension("orders.csv"), ".csv");
  assert.equal(uploadExtension("Takeout.JSON"), ".json");
  assert.equal(uploadExtension("history.jsonl"), ".jsonl");
  assert.equal(uploadExtension("C:\\exports\\events.NDJSON"), ".ndjson");
  // Any other name is stored, and read, as CSV, as every upload was in #595.
  for (const name of ["notes.txt", "export", "a.json.gz", "a.parquet", ".json"]) {
    assert.equal(uploadExtension(name), ".csv", name);
  }
  // Every extension an upload is stored with is one a directory source reads,
  // and one the form's picker offers.
  const accept = UPLOAD_ACCEPT.split(",");
  for (const ext of UPLOAD_EXTENSIONS) {
    assert.ok(readerFor(ext), `no directory reader for ${ext}`);
    assert.ok(accept.includes(ext), `the picker does not offer ${ext}`);
  }
  assert.equal(readerFor(".json"), "read_json_auto");
});

test("an upload lands under uploads/<workspace>/<fresh id>/, one file per file, by its extension", async () => {
  const dir = root();
  const result = await upload(dir, [
    { name: "Orders.csv", body: "id,amount\n1,5\n" },
    { name: "my customers.txt", body: "id,name\n1,ada\n" },
    { name: "Workouts.JSONL", body: '{"a":1}\n' },
  ]);
  assert.match(result.path, /^uploads\/ops\/[0-9a-f]{16}$/);
  assert.deepEqual(result.files, [
    { name: "orders", bytes: 14 },
    { name: "my_customers", bytes: 14 },
    { name: "workouts", bytes: 8 },
  ]);
  const stored = join(dir, result.path);
  assert.deepEqual(readdirSync(stored).sort(), [
    "my_customers.csv",
    "orders.csv",
    "workouts.jsonl",
  ]);
  assert.equal(readFileSync(join(stored, "orders.csv"), "utf8"), "id,amount\n1,5\n");
  // Two uploads never share a directory.
  const again = await upload(dir, [{ name: "orders.csv", body: "id\n1\n" }]);
  assert.notEqual(again.path, result.path);
});

test("the byte cap, the file cap, the text check and the stem rules each refuse the whole upload", async () => {
  const dir = root();
  writable.duckdbUploadMaxBytes = 100;
  writable.duckdbUploadMaxFiles = 2;
  try {
    await refused(
      dir,
      [
        { name: "ok.csv", body: "a\n1\n" },
        { name: "big.csv", body: "x".repeat(101) },
      ],
      /"big\.csv" is larger than 100 bytes \(DUCKDB_UPLOAD_MAX_BYTES\)/,
      "big.csv",
    );
    await refused(
      dir,
      [
        { name: "a.csv", body: "a\n" },
        { name: "b.csv", body: "b\n" },
        { name: "c.csv", body: "c\n" },
      ],
      /at most 2 files/,
    );
    await refused(
      dir,
      [{ name: "sheet.csv", body: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]) }],
      /"sheet\.csv" is not a text file/,
      "sheet.csv",
    );
    await refused(
      dir,
      [{ name: "latin1.csv", body: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) }],
      /not UTF-8/,
    );
    await refused(
      dir,
      [{ name: "empty.csv", body: "" }],
      /"empty\.csv" is empty/,
      "empty.csv",
    );
    await refused(dir, [{ name: "---.csv", body: "a\n" }], /no name left/);
    await refused(
      dir,
      [
        { name: "Sales.csv", body: "a\n" },
        { name: "sales.txt", body: "b\n" },
      ],
      /both be the table "sales"/,
    );
    // A JSON file is held to the same text check, and shares the stem rule
    // with CSV: one table per stem, whatever the extension.
    await refused(
      dir,
      [{ name: "dump.json", body: Buffer.from([0x7b, 0x00, 0x7d]) }],
      /"dump\.json" is not a text file/,
      "dump.json",
    );
    await refused(
      dir,
      [
        { name: "events.csv", body: "a\n" },
        { name: "events.jsonl", body: '{"a":1}\n' },
      ],
      /both be the table "events"/,
    );
    await refused(dir, [], /at least one CSV, JSON or Excel file/);
    await refused(
      dir,
      [{ name: "a.csv", body: "a\n", field: "other" }],
      /must be a file in "files"/,
    );
  } finally {
    Object.assign(writable, saved);
  }
});

test("a cancelled or malformed request keeps nothing", async () => {
  const dir = root();
  const files = [{ name: "a.csv", body: "x".repeat(5000) }];
  await assert.rejects(
    upload(dir, files, { size: 512, stopAfter: 2048 }),
    (err: unknown) => {
      assert.ok(err instanceof UploadError);
      assert.match(err.message, /nothing was kept/);
      return true;
    },
  );
  nothingKept(dir);
  await assert.rejects(
    receiveUpload({
      workspaceId: "ops",
      contentType: "application/json",
      body: stream(Buffer.from("{}")),
      root: dir,
    }),
    /multipart\/form-data/,
  );
  // A workspace id that could not name a directory takes no upload.
  for (const workspaceId of ["..", ".hidden", "a b", ""]) {
    await assert.rejects(
      receiveUpload({
        workspaceId,
        contentType: `multipart/form-data; boundary=${BOUNDARY}`,
        body: stream(multipart(files)),
        root: dir,
      }),
      /cannot name an upload directory/,
    );
  }
});

test("uploads are off, naming the variable and no path, when the root is unset or not writable", async () => {
  assert.match(String(await uploadsAvailability("")), /DUCKDB_SOURCES_DIR/);
  const dir = root();
  assert.equal(await uploadsAvailability(dir), null);
  assert.ok(existsSync(join(dir, "uploads")), "made on first ask");
  const missing = await uploadsAvailability(join(dir, "nope"));
  assert.match(String(missing), /DUCKDB_SOURCES_DIR/);
  if (process.getuid?.() !== 0) {
    const locked = root();
    chmodSync(locked, 0o555);
    try {
      const reason = String(await uploadsAvailability(locked));
      assert.match(reason, /cannot write uploads\/ under DUCKDB_SOURCES_DIR/);
      assert.ok(!reason.includes(locked));
    } finally {
      chmodSync(locked, 0o755);
    }
  }
  await assert.rejects(
    receiveUpload({ workspaceId: "ops", contentType: null, body: null, root: "" }),
    (err: Error) => err.message === SOURCES_DIR_UNSET,
  );
});

test("removing a deleted source's files touches only its own upload directory", async () => {
  const dir = root();
  const { path } = await upload(dir, [{ name: "a.csv", body: "a\n1\n" }]);
  mkdirSync(join(dir, "lake"));
  // Not an upload: an operator's directory is never removed.
  assert.equal(await removeUpload({ workspaceId: "ops", path: "lake" }, [], dir), false);
  assert.ok(existsSync(join(dir, "lake")));
  // Another workspace's source cannot remove it.
  assert.equal(await removeUpload({ workspaceId: "fin", path }, [], dir), false);
  // Still named by another source in the workspace: kept.
  assert.equal(await removeUpload({ workspaceId: "ops", path }, [path], dir), false);
  assert.ok(existsSync(join(dir, path)));
  assert.equal(await removeUpload({ workspaceId: "ops", path }, [], dir), true);
  assert.ok(!existsSync(join(dir, path)));
});

/* -------------------------------------------------------------------------- */
/* Excel workbooks (#597)                                                     */
/* -------------------------------------------------------------------------- */

/** A ZIP archive of `entries`, each deflated (or stored, when `stored`). */
function zip(entries: Record<string, string | Buffer>, stored = false): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const data = stored ? raw : deflateRawSync(raw);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc32(raw), 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(stored ? 0 : 8, 10);
    head.writeUInt32LE(crc32(raw), 16);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

type SheetSpec = { name: string; rows: string; state?: string };

/**
 * An `.xlsx` workbook: sheets of raw `<row>` XML, optional shared strings
 * and cell styles (`numFmtIds`, one per `cellXfs` entry, custom formats in
 * `formats`), in the 1904 date system when asked.
 */
function xlsx(
  sheets: SheetSpec[],
  opts: {
    shared?: string[];
    numFmtIds?: number[];
    formats?: Record<number, string>;
    date1904?: boolean;
    extra?: Record<string, string | Buffer>;
  } = {},
): Buffer {
  const parts: Record<string, string | Buffer> = {
    "[Content_Types].xml": "<Types/>",
    "_rels/.rels": `<Relationships><Relationship Id="r1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `<workbook ${NS} xmlns:r="${REL}"><workbookPr${opts.date1904 ? ' date1904="1"' : ""}/><sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ""}/>`,
      )
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships>${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        "",
      )}<Relationship Id="rS" Type="${REL}/sharedStrings" Target="/xl/sharedStrings.xml"/><Relationship Id="rT" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    "xl/sharedStrings.xml": `<sst ${NS}>${(opts.shared ?? [])
      .map((t) => `<si><t xml:space="preserve">${t}</t></si>`)
      .join("")}</sst>`,
    "xl/styles.xml": `<styleSheet ${NS}><numFmts>${Object.entries(opts.formats ?? {})
      .map(([id, code]) => `<numFmt numFmtId="${id}" formatCode="${code}"/>`)
      .join("")}</numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs>${(
      opts.numFmtIds ?? [0]
    )
      .map((id) => `<xf numFmtId="${id}"/>`)
      .join("")}</cellXfs></styleSheet>`,
    ...Object.fromEntries(
      sheets.map((s, i) => [
        `xl/worksheets/sheet${i + 1}.xml`,
        `<worksheet ${NS}><sheetData>${s.rows}</sheetData></worksheet>`,
      ]),
    ),
    ...opts.extra,
  };
  return zip(parts);
}

/** A row of inline-string and number cells, by position. */
function row(r: number, ...cells: (string | number | null)[]): string {
  const letters = "ABCDEFGHIJ";
  return `<row r="${r}">${cells
    .map((c, i) =>
      c === null
        ? ""
        : typeof c === "number"
          ? `<c r="${letters[i]}${r}"><v>${c}</v></c>`
          : `<c r="${letters[i]}${r}" t="inlineStr"><is><t>${c}</t></is></c>`,
    )
    .join("")}</row>`;
}

const SAMPLE = readFileSync(join(process.cwd(), "public/samples/home-energy.xlsx"));

test("a workbook of two sheets becomes one CSV per sheet, <stem>_<sheet>, and is not kept", async () => {
  const dir = root();
  const result = await upload(dir, [{ name: "home-energy.xlsx", body: SAMPLE }], {
    size: 4096,
  });
  assert.deepEqual(result.files, [
    {
      name: "home_energy",
      bytes: SAMPLE.length,
      views: ["home_energy_electricity", "home_energy_gas"],
    },
  ]);
  const stored = join(dir, result.path);
  assert.deepEqual(readdirSync(stored).sort(), [
    "home_energy_electricity.csv",
    "home_energy_gas.csv",
  ]);
  const gas = readFileSync(join(stored, "home_energy_gas.csv"), "utf8").split("\n");
  // The sample's date cells are real dates, written as ISO dates; numbers bare.
  assert.equal(gas[0], '"date","therms","cost_usd"');
  assert.match(gas[1] ?? "", /^2026-04-01,\d+(\.\d+)?,\d+(\.\d+)?$/);
  assert.equal(gas.length, 1 + 183 + 1);
  // Every converted file is one a directory source reads; the sample is offered.
  assert.ok(UPLOAD_ACCEPT.split(",").includes(WORKBOOK_EXTENSION));
});

test("a workbook's cells: shared and inline text, numbers, booleans, errors, formulas' cached values and dates", async () => {
  const dir = root();
  const sheet = [
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><r><t>am</t></r><r><t>ount</t></r></is></c><c r="D1" t="s"><v>1</v></c><c r="E1" t="s"><v>2</v></c><c r="F1" t="s"><v>3</v></c></row>`,
    // Row 2 is empty: passed over. Row 3 holds every kind of cell.
    `<row r="2"/>`,
    `<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="b"><v>1</v></c><c r="C3"><f>1+1</f><v>2</v></c><c r="D3" t="e"><v>#DIV/0!</v></c><c r="E3" s="1"><v>46113</v></c><c r="F3" s="2"><v>46113.5</v></c><c r="G3" t="str"><f>A3</f><v>a, "b"</v></c><c r="H3" t="d"><v>2026-04-02T10:00:00</v></c></row>`,
    `<row r="4"><c r="A4" t="s"><v>5</v></c><c r="B4" t="b"><v>0</v></c><c r="E4" s="3"><v>0.25</v></c></row>`,
  ].join("");
  const book = xlsx(
    [
      { name: "Data", rows: sheet },
      { name: "Secret", rows: row(1, "x"), state: "hidden" },
      { name: "Blank", rows: "" },
    ],
    {
      shared: ["zip", "ok", "date", "at", "00123", "line&#10;two"],
      numFmtIds: [0, 14, 164, 165],
      formats: { 164: "yyyy-mm-dd hh:mm", 165: "h:mm AM/PM" },
    },
  );
  const result = await upload(dir, [{ name: "Budget 2026.xlsx", body: book }], {
    size: 512,
  });
  // One sheet with data: the view is the file's own stem. Hidden and empty
  // sheets are skipped and said.
  assert.deepEqual(result.files, [
    {
      name: "budget_2026",
      bytes: book.length,
      views: ["budget_2026"],
      skipped: [
        { sheet: "Secret", reason: "hidden" },
        { sheet: "Blank", reason: "empty" },
      ],
    },
  ]);
  const csv = readFileSync(join(dir, result.path, "budget_2026.csv"), "utf8");
  assert.equal(
    csv,
    [
      '"zip","column_2","amount","ok","date","at","column_7","column_8"',
      '"00123",true,2,,2026-04-01,2026-04-01T12:00:00,"a, ""b""",2026-04-02T10:00:00',
      '"line\ntwo",false,,,06:00:00,,,',
      "",
    ].join("\n"),
  );
});

test("dates follow the workbook's date system and number formats, in UTC", () => {
  assert.equal(excelSerialToMs(46113, false), Date.UTC(2026, 3, 1));
  assert.equal(excelSerialToMs(1, false), Date.UTC(1900, 0, 1));
  assert.equal(excelSerialToMs(61, false), Date.UTC(1900, 2, 1));
  assert.equal(excelSerialToMs(0, true), Date.UTC(1904, 0, 1));
  assert.equal(excelSerialToMs(46113.75, false), Date.UTC(2026, 3, 1, 18));
  assert.equal(excelSerialToMs(-1, false), null);
  assert.equal(formatShows("yyyy-mm-dd"), "date");
  assert.equal(formatShows("d mmm yyyy h:mm"), "datetime");
  assert.equal(formatShows("[$-409]h:mm:ss AM/PM"), "time");
  assert.equal(formatShows("mm:ss"), "time");
  // Not dates: a number with quoted text, a color, an elapsed duration.
  assert.equal(formatShows('#,##0.00 "kWh"'), null);
  assert.equal(formatShows("[Red]0.00;[Blue]-0.00"), null);
  assert.equal(formatShows("[h]:mm"), null);
  assert.equal(formatShows("General"), null);
  assert.equal(formatShows("0.00E+00"), null);
});

test("a sheet's table name is <stem>_<sheet> reduced to [a-z0-9_], or nothing", () => {
  assert.equal(sheetViewName("home_energy", "Electricity"), "home_energy_electricity");
  assert.equal(sheetViewName("budget", "Q1 / 2026 (draft)"), "budget_q1_2026_draft");
  assert.equal(sheetViewName("b", "Ünïcode"), "b_n_code");
  for (const empty of ["", "---", "  ", "日本"]) {
    assert.equal(sheetViewName("b", empty), null, empty);
  }
  assert.ok((sheetViewName("a".repeat(60), "sheet") ?? "").length <= 64);
});

test("the sheet cap, the row cap and the converted-size cap each refuse the whole upload, naming the sheet", async () => {
  const dir = root();
  const three = xlsx([
    { name: "One", rows: row(1, "a") + row(2, 1) },
    { name: "Two", rows: row(1, "a") + row(2, 1) },
    { name: "Three", rows: row(1, "a") + row(2, 1) },
  ]);
  await refused(
    dir,
    [
      { name: "ok.csv", body: "a\n1\n" },
      { name: "book.xlsx", body: three },
    ],
    /"book\.xlsx" could not be converted: sheet "Three" is past the 2 sheets/,
    "book.xlsx",
    { workbookCaps: { maxSheets: 2 } },
  );
  const long = xlsx([
    {
      name: "Log",
      rows: Array.from({ length: 6 }, (_, i) => row(i + 1, i)).join(""),
    },
  ]);
  await refused(
    dir,
    [{ name: "log.xlsx", body: long }],
    /sheet "Log" has more than 5 rows/,
    "log.xlsx",
    { workbookCaps: { maxRows: 5 } },
  );
  // A workbook small as received, its CSV large: the converted bytes count too.
  writable.duckdbUploadMaxBytes = 4000;
  try {
    const wide = xlsx([
      {
        name: "Wide",
        // Rows without references, so the archive compresses them well.
        rows: "<row><c><v>1</v></c><c><v>2</v></c><c><v>3</v></c></row>".repeat(800),
      },
    ]);
    assert.ok(wide.length < 4000, `the workbook is ${wide.length} bytes`);
    await refused(
      dir,
      [{ name: "wide.xlsx", body: wide }],
      /sheet "Wide" takes its CSVs past 4000 bytes \(DUCKDB_UPLOAD_MAX_BYTES\)/,
      "wide.xlsx",
      { size: 1024 },
    );
  } finally {
    Object.assign(writable, saved);
  }
  assert.ok(MAX_WORKBOOK_SHEETS >= 2 && MAX_SHEET_ROWS >= 1_000);
});

test("sheet names that reduce to nothing or collide, and other spreadsheets, are refused by name", async () => {
  const dir = root();
  const sheet = row(1, "a") + row(2, 1);
  await refused(
    dir,
    [
      {
        name: "b.xlsx",
        body: xlsx([
          { name: "Data", rows: sheet },
          { name: "---", rows: sheet },
        ]),
      },
    ],
    /sheet "---" has no name left/,
    "b.xlsx",
  );
  await refused(
    dir,
    [
      {
        name: "b.xlsx",
        body: xlsx([
          { name: "Q 1", rows: sheet },
          { name: "q_1", rows: sheet },
        ]),
      },
    ],
    /sheets "Q 1" and "q_1" would both be the table "b_q_1"/,
  );
  await refused(
    dir,
    [
      { name: "home_energy_gas.csv", body: "a\n1\n" },
      { name: "home-energy.xlsx", body: SAMPLE },
    ],
    /sheet "Gas" would be the table "home_energy_gas", which another file/,
    "home-energy.xlsx",
    { size: 4096 },
  );
  // A later file cannot take a table a workbook's sheet became.
  await refused(
    dir,
    [
      { name: "home-energy.xlsx", body: SAMPLE },
      { name: "home_energy_gas.jsonl", body: '{"a":1}\n' },
    ],
    /both be the table "home_energy_gas"/,
    undefined,
    { size: 4096 },
  );
  for (const [name, what] of [
    ["budget.xls", "an older Excel workbook"],
    ["Budget.ODS", "an OpenDocument spreadsheet"],
    ["plan.numbers", "a Numbers spreadsheet"],
  ] as const) {
    assert.match(String(spreadsheetProblem(name)), new RegExp(what));
    await refused(
      dir,
      [{ name, body: Buffer.from([0xd0, 0xcf, 0x11, 0xe0]) }],
      /save it as an Excel Workbook \(\.xlsx\) or as CSV/,
      name,
    );
  }
  assert.equal(spreadsheetProblem("orders.csv"), null);
  assert.equal(spreadsheetProblem("book.xlsx"), null);
});

test("a workbook that is not a readable archive, or that inflates past its cap, keeps nothing", async () => {
  const dir = root();
  await refused(
    dir,
    [{ name: "fake.xlsx", body: "a,b\n1,2\n" }],
    /"fake\.xlsx" could not be converted: it is not an \.xlsx workbook that can be read: it is not a ZIP archive/,
    "fake.xlsx",
  );
  await refused(
    dir,
    [{ name: "nothing.xlsx", body: zip({ "a.txt": "hello" }) }],
    /it is not an Excel workbook/,
  );
  await refused(
    dir,
    [{ name: "empty.xlsx", body: xlsx([{ name: "Blank", rows: "" }]) }],
    /it has no sheet with data/,
  );
  await refused(
    dir,
    [{ name: "bad.xlsx", body: xlsx([{ name: "S", rows: "<row><c><v>1</row>" }]) }],
    /not well-formed XML/,
  );
  await refused(
    dir,
    [
      {
        name: "wide.xlsx",
        body: xlsx([
          { name: "Wide", rows: '<row><c r="XFE1"><v>1</v></c><c><v>2</v></c></row>' },
        ]),
      },
    ],
    /sheet "Wide" has more than 16384 columns/,
  );
  // An entity it was not born with is not expanded, let alone a recursive one.
  await refused(
    dir,
    [
      {
        name: "entity.xlsx",
        body: xlsx([{ name: "S", rows: row(1, "&lol;") }]),
      },
    ],
    /not well-formed XML/,
  );
  // Shared strings that inflate past the held-part cap stop at the cap.
  const bomb = Buffer.alloc(129 * 1024 * 1024, 0x20);
  await refused(
    dir,
    [
      {
        name: "bomb.xlsx",
        body: xlsx([{ name: "S", rows: row(1, "a") }], {
          extra: {
            "xl/sharedStrings.xml": Buffer.concat([Buffer.from(`<sst ${NS}>`), bomb]),
          },
        }),
      },
    ],
    /inflates past 134217728 bytes/,
    "bomb.xlsx",
    { size: 64 * 1024 },
  );
  // A stored (uncompressed) archive reads like a deflated one.
  const storedBook = zip(
    {
      "_rels/.rels": `<Relationships><Relationship Id="r1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": `<workbook ${NS} xmlns:r="${REL}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
      "xl/worksheets/sheet1.xml": `<worksheet ${NS}><sheetData>${row(1, "n")}${row(2, 7)}</sheetData></worksheet>`,
    },
    true,
  );
  const result = await upload(dir, [{ name: "stored.xlsx", body: storedBook }]);
  assert.equal(readFileSync(join(dir, result.path, "stored.csv"), "utf8"), '"n"\n7\n');
});

/* -------------------------------------------------------------------------- */
/* Adding files to an upload source (#604)                                    */
/* -------------------------------------------------------------------------- */

const add = (dir: string, into: string, files: FilePart[], opts: UploadOptions = {}) =>
  receiveUpload({
    workspaceId: "ops",
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    body: stream(multipart(files), opts.size ?? 7, opts.stopAfter),
    into,
    root: dir,
    workbookCaps: opts.workbookCaps,
  });

/** Every file under a directory, by relative name, with its contents. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string, prefix: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), rel);
      else out[rel] = readFileSync(join(at, entry.name), "utf8");
    }
  };
  walk(dir, "");
  return out;
}

/** A refused add: an UploadError naming no path, and the root exactly as it was. */
async function addRefused(
  dir: string,
  into: string,
  files: FilePart[],
  message: RegExp,
  opts: UploadOptions = {},
) {
  const before = snapshot(dir);
  await assert.rejects(add(dir, into, files, opts), (err: unknown) => {
    assert.ok(err instanceof UploadError || err instanceof DuckDbPathError, String(err));
    assert.match(err.message, message);
    assert.ok(!err.message.includes(dir), `a path leaked: ${err.message}`);
    return true;
  });
  assert.deepEqual(snapshot(dir), before, "a refused add changed the files");
}

test("files are added to the source's own directory, beside what it holds, which is untouched", async () => {
  const dir = root();
  const { path } = await upload(dir, [{ name: "january.csv", body: "a\n1\n" }]);
  const result = await add(dir, path, [
    { name: "february.csv", body: "a\n2\n" },
    { name: "runs.jsonl", body: '{"a":3}\n' },
  ]);
  // The same reply shape, the path the source's own.
  assert.equal(result.path, path);
  assert.deepEqual(
    result.files.map((f) => f.name),
    ["february", "runs"],
  );
  assert.deepEqual(snapshot(join(dir, path)), {
    "january.csv": "a\n1\n",
    "february.csv": "a\n2\n",
    "runs.jsonl": '{"a":3}\n',
  });
  // Nothing staged is left beside it.
  assert.deepEqual(readdirSync(join(dir, "uploads", "ops")), [path.split("/")[2]]);
  // A workbook, and one under the .xlsm name, convert into it too.
  await add(dir, path, [{ name: "home-energy.xlsm", body: SAMPLE }], { size: 4096 });
  assert.deepEqual(readdirSync(join(dir, path)).sort(), [
    "february.csv",
    "home_energy_electricity.csv",
    "home_energy_gas.csv",
    "january.csv",
    "runs.jsonl",
  ]);
});

test("only an upload directory of the source's own workspace takes files, checked before anything is written", async () => {
  const dir = root();
  const { path } = await upload(dir, [{ name: "a.csv", body: "a\n1\n" }]);
  mkdirSync(join(dir, "lake"));
  writeFileSync(join(dir, "lake", "x.csv"), "x\n1\n");
  const files = [{ name: "b.csv", body: "b\n1\n" }];
  // A directory the operator manages is not an upload source.
  await addRefused(
    dir,
    "lake",
    files,
    /only a source made by uploading files takes more/,
  );
  // Another workspace's upload directory, however it is spelled.
  for (const into of [path.replace("/ops/", "/fin/"), `${path}/..`, "uploads/ops"]) {
    await assert.rejects(
      receiveUpload({
        workspaceId: "fin",
        contentType: `multipart/form-data; boundary=${BOUNDARY}`,
        body: stream(multipart(files)),
        into,
        root: dir,
      }),
      (err: unknown) => err instanceof UploadError || err instanceof DuckDbPathError,
    );
  }
  assert.deepEqual(readdirSync(join(dir, path)), ["a.csv"]);
  assert.ok(
    !existsSync(join(dir, "uploads", "fin")) ||
      readdirSync(join(dir, "uploads", "fin")).length === 0,
  );
  // A directory that is gone is refused by the guard, naming no path.
  await addRefused(dir, "uploads/ops/0123456789abcdef", files, /does not exist/);
  assert.ok(isUploadPath(path, "ops"));
  assert.ok(!isUploadPath(path, "fin"));
  assert.ok(!isUploadPath("lake", "ops"));
});

test("a table the source already has is refused by name, a workbook's sheets included", async () => {
  const dir = root();
  const { path } = await upload(
    dir,
    [
      { name: "expenses.csv", body: "a\n1\n" },
      { name: "home-energy.xlsx", body: SAMPLE },
    ],
    { size: 4096 },
  );
  // The same stem, whatever its extension.
  await addRefused(
    dir,
    path,
    [
      { name: "new.csv", body: "a\n1\n" },
      { name: "Expenses.jsonl", body: '{"a":1}\n' },
    ],
    /"Expenses\.jsonl" would be the table "expenses", which is already a table in this source; rename it/,
  );
  // A sheet's table counts as a table the source has.
  await addRefused(
    dir,
    path,
    [{ name: "home_energy_gas.csv", body: "a\n1\n" }],
    /already a table in this source/,
  );
  // And a new workbook's sheet may not take one.
  await addRefused(
    dir,
    path,
    [{ name: "home-energy.xlsm", body: SAMPLE }],
    /sheet "Electricity" would be the table "home_energy_electricity", which is already a table in this source/,
    { size: 4096 },
  );
  const twoSheets = xlsx([
    { name: "Expenses", rows: row(1, "a") + row(2, 1) },
    { name: "Other", rows: row(1, "a") + row(2, 1) },
  ]);
  await add(dir, path, [{ name: "book.xlsx", body: twoSheets }]);
  await addRefused(
    dir,
    path,
    [{ name: "book.xlsm", body: twoSheets }],
    /already a table in this source/,
  );
});

test("the file cap counts the files the source already holds", async () => {
  const dir = root();
  writable.duckdbUploadMaxFiles = 3;
  try {
    const { path } = await upload(dir, [
      { name: "a.csv", body: "a\n1\n" },
      { name: "b.csv", body: "b\n1\n" },
    ]);
    await addRefused(
      dir,
      path,
      [
        { name: "c.csv", body: "c\n1\n" },
        { name: "d.csv", body: "d\n1\n" },
      ],
      /already holds 2 files; it may hold at most 3 \(DUCKDB_UPLOAD_MAX_FILES\)/,
    );
    // A workbook's sheets are each a file once converted.
    await addRefused(
      dir,
      path,
      [{ name: "home-energy.xlsx", body: SAMPLE }],
      /past the 3 it may hold \(DUCKDB_UPLOAD_MAX_FILES\)/,
      { size: 4096 },
    );
    await add(dir, path, [{ name: "c.csv", body: "c\n1\n" }]);
    await addRefused(
      dir,
      path,
      [{ name: "d.csv", body: "d\n1\n" }],
      /already holds 3 files/,
    );
  } finally {
    writable.duckdbUploadMaxFiles = saved.duckdbUploadMaxFiles;
  }
});

test("a refused or cancelled add leaves the existing files as they were and nothing new", async () => {
  const dir = root();
  const { path } = await upload(dir, [{ name: "keep.csv", body: "k\n1\n" }]);
  // The second file is refused after the first was written to staging.
  await addRefused(
    dir,
    path,
    [
      { name: "fine.csv", body: "f\n1\n" },
      { name: "bad.csv", body: "a\u0000b" },
    ],
    /is not a text file/,
  );
  await addRefused(dir, path, [{ name: "empty.csv", body: "" }], /is empty/);
  const body = multipart([
    { name: "fine.csv", body: "f\n1\n" },
    { name: "more.csv", body: "m\n".repeat(200) },
  ]);
  await addRefused(
    dir,
    path,
    [
      { name: "fine.csv", body: "f\n1\n" },
      { name: "more.csv", body: "m\n".repeat(200) },
    ],
    /did not finish/,
    {
      stopAfter: body.length - 50,
    },
  );
  // A name that appeared in the source meanwhile (after its files were
  // read, while the body streamed) is never overwritten: the exclusive link
  // refuses, and only what this request linked is removed.
  const raced = multipart([
    { name: "aaa.csv", body: "a\n1\n" },
    { name: "zzz.csv", body: "mine\n" },
  ]);
  let offset = 0;
  const staged = receiveUpload({
    workspaceId: "ops",
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    body: new ReadableStream({
      pull(controller) {
        // The second pull: the body is being read, the source's files were.
        if (offset === 16) writeFileSync(join(dir, path, "zzz.csv"), "theirs\n");
        if (offset >= raced.length) {
          controller.close();
          return;
        }
        controller.enqueue(raced.slice(offset, offset + 16));
        offset += 16;
      },
    }),
    into: path,
    root: dir,
  });
  await assert.rejects(staged, /"zzz" is already in this source/);
  assert.deepEqual(snapshot(join(dir, path)), {
    "keep.csv": "k\n1\n",
    "zzz.csv": "theirs\n",
  });
  assert.deepEqual(readdirSync(join(dir, "uploads", "ops")), [path.split("/")[2]]);
});

test("the sample workbook under an .xlsm name yields the same tables as under .xlsx", async () => {
  const dir = root();
  const asXlsx = await upload(dir, [{ name: "home-energy.xlsx", body: SAMPLE }], {
    size: 4096,
  });
  const asXlsm = await upload(dir, [{ name: "home-energy.xlsm", body: SAMPLE }], {
    size: 4096,
  });
  assert.deepEqual(asXlsm.files, asXlsx.files);
  assert.deepEqual(snapshot(join(dir, asXlsm.path)), snapshot(join(dir, asXlsx.path)));
  // Accepted where it used to be refused; its older kin still are.
  assert.equal(spreadsheetProblem("macros.xlsm"), null);
  assert.ok(UPLOAD_ACCEPT.split(",").includes(".xlsm"));
  assert.match(String(spreadsheetProblem("book.xlsb")), /a binary Excel workbook/);
});

test("the listing says whether a source was made by uploading, and never its path", () => {
  const record = (path: string) =>
    ({
      id: "s",
      workspaceId: "ops",
      name: "S",
      kind: "duckdb",
      config: { kind: "duckdb", path, tables: [{ name: "t", columns: [] }] },
      secretRef: null,
      catalogRefreshedAt: null,
      catalogMissingTables: [],
      catalogFacts: null,
      createdBy: "u",
      createdAt: "",
      updatedAt: "",
      tombstonedAt: null,
    }) as unknown as SourceRecord;
  const uploaded = duckdb.listing(record("uploads/ops/0123456789abcdef"));
  assert.equal(uploaded.uploaded, true);
  assert.ok(!JSON.stringify(uploaded).includes("uploads/"), "the path leaked");
  assert.equal(duckdb.listing(record("lake")).uploaded, false);
  // Another workspace's upload path (refused on save anyway) is not one.
  assert.equal(duckdb.listing(record("uploads/fin/0123456789abcdef")).uploaded, false);
});

/* -------------------------------------------------------------------------- */
/* The sweep for orphaned uploads (#604)                                      */
/* -------------------------------------------------------------------------- */

/** Make a directory, and everything in it, `ageMs` old. */
function age(path: string, ageMs: number) {
  const when = (Date.now() - ageMs) / 1000;
  for (const name of readdirSync(path)) utimesSync(join(path, name), when, when);
  utimesSync(path, when, when);
}

async function sweep(
  dir: string,
  named: Record<string, string[]>,
  workspaceId?: string,
): Promise<{ removed: number; kept: number; lines: Record<string, unknown>[] }> {
  const lines: Record<string, unknown>[] = [];
  const restore = setLogger(
    createLogger({
      level: "debug",
      format: "json",
      sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  );
  try {
    const counts = await sweepOrphanedUploads({
      root: dir,
      workspaceId,
      named: async (ws) => named[ws] ?? [],
    });
    return { ...counts, lines };
  } finally {
    restore();
  }
}

const OLD = UPLOAD_ORPHAN_AGE_MS + 60_000;

test("the sweep removes an old upload no source names, and keeps a young or a named one", async () => {
  const dir = root();
  const orphan = (await upload(dir, [{ name: "a.csv", body: "a\n1\n" }])).path;
  const young = (await upload(dir, [{ name: "b.csv", body: "b\n1\n" }])).path;
  const named = (await upload(dir, [{ name: "c.csv", body: "c\n1\n" }])).path;
  const tombstoned = (await upload(dir, [{ name: "d.csv", body: "d\n1\n" }])).path;
  age(join(dir, orphan), OLD);
  age(join(dir, named), OLD * 24);
  age(join(dir, tombstoned), OLD);
  // A directory with one fresh file in it is as young as that file.
  const touched = (await upload(dir, [{ name: "e.csv", body: "e\n1\n" }])).path;
  age(join(dir, touched), OLD);
  writeFileSync(join(dir, touched, "f.csv"), "f\n1\n");
  // An add-files request's abandoned staging directory is an orphan too.
  const staging = join(dir, "uploads", "ops", `${STAGING_PREFIX}0011223344556677`);
  mkdirSync(staging);
  writeFileSync(join(staging, "x.csv"), "x\n");
  age(staging, OLD);

  const result = await sweep(dir, { ops: [named, `${tombstoned}/`] });
  assert.equal(result.removed, 2);
  assert.equal(result.kept, 4);
  assert.ok(!existsSync(join(dir, orphan)));
  assert.ok(!existsSync(staging));
  for (const kept of [young, named, tombstoned, touched]) {
    assert.ok(existsSync(join(dir, kept)), `${kept} was removed`);
  }
  // The log line carries counts, never a path.
  const line = result.lines.find((l) => l.msg === "uploads.swept");
  assert.ok(line, "no uploads.swept line");
  assert.equal(line.removed, 2);
  assert.equal(line.kept, 4);
  const text = JSON.stringify(result.lines);
  assert.ok(!text.includes(dir) && !text.includes("uploads/"), `a path leaked: ${text}`);
});

test("the sweep never touches anything outside uploads/, a bad workspace segment or a link", async () => {
  const dir = root();
  // An operator's directory, old and named by nothing.
  mkdirSync(join(dir, "lake"));
  writeFileSync(join(dir, "lake", "x.csv"), "x\n");
  age(join(dir, "lake"), OLD);
  // A workspace segment that is no workspace id.
  for (const ws of ["_bad", "-x"]) {
    mkdirSync(join(dir, "uploads", ws, "abc"), { recursive: true });
    age(join(dir, "uploads", ws, "abc"), OLD);
  }
  // A symlink under a workspace, pointing out of uploads/.
  mkdirSync(join(dir, "uploads", "ops"), { recursive: true });
  symlinkSync(join(dir, "lake"), join(dir, "uploads", "ops", "link"));
  // A file where a directory would be.
  writeFileSync(join(dir, "uploads", "ops", "stray.csv"), "s\n");

  const result = await sweep(dir, {});
  assert.equal(result.removed, 0);
  assert.ok(existsSync(join(dir, "lake", "x.csv")));
  assert.ok(existsSync(join(dir, "uploads", "_bad", "abc")));
  assert.ok(existsSync(join(dir, "uploads", "-x", "abc")));
  assert.ok(existsSync(join(dir, "uploads", "ops", "link")));
  assert.ok(existsSync(join(dir, "uploads", "ops", "stray.csv")));
});

test("the sweep asks after listing, keeps everything when it cannot ask, and stays in its workspace", async () => {
  const dir = root();
  const mine = (await upload(dir, [{ name: "a.csv", body: "a\n1\n" }])).path;
  const other = (
    await receiveUpload({
      workspaceId: "fin",
      contentType: `multipart/form-data; boundary=${BOUNDARY}`,
      body: stream(multipart([{ name: "b.csv", body: "b\n1\n" }])),
      root: dir,
    })
  ).path;
  age(join(dir, mine), OLD);
  age(join(dir, other), OLD);

  // The lookup failing keeps every candidate.
  const failed = await sweepOrphanedUploads({
    root: dir,
    named: async () => {
      throw new Error("database down");
    },
  });
  assert.deepEqual(failed, { removed: 0, kept: 2 });
  assert.ok(existsSync(join(dir, mine)) && existsSync(join(dir, other)));

  // Asked only once the directories are listed: a source named meanwhile counts.
  const asked: string[] = [];
  const scoped = await sweepOrphanedUploads({
    root: dir,
    workspaceId: "ops",
    named: async (ws) => {
      asked.push(ws);
      return [];
    },
  });
  assert.deepEqual(asked, ["ops"]);
  assert.deepEqual(scoped, { removed: 1, kept: 0 });
  assert.ok(!existsSync(join(dir, mine)));
  assert.ok(existsSync(join(dir, other)), "another workspace's upload was swept");
  // No root, no uploads/: nothing to do, and no throw.
  assert.deepEqual(await sweepOrphanedUploads({ root: "", named: async () => [] }), {
    removed: 0,
    kept: 0,
  });
  assert.deepEqual(await sweepOrphanedUploads({ root: root(), named: async () => [] }), {
    removed: 0,
    kept: 0,
  });
});
