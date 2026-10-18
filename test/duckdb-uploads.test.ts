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
  textProblem,
  UploadError,
  uploadExtension,
  uploadsAvailability,
  uploadStem,
} from "@/lib/duckdb/uploads";
import { readerFor } from "@/lib/duckdb/client";
import { excelSerialToMs, formatShows, sheetViewName } from "@/lib/duckdb/workbook";
import {
  spreadsheetProblem,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  WORKBOOK_EXTENSION,
} from "@/lib/sources/kinds/duckdb";
import { SOURCES_DIR_UNSET } from "@/lib/duckdb/path";
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
    `<row r="3"><c r="A3" t="s"><v>4</v></c><c r="B3" t="b"><v>1</v></c><c r="C3"><f>1+1</f><v>2</v></c><c r="D3" t="e"><v>#DIV/0!</v></c><c r="E3" s="1"><v>46113</v></c><c r="F3" s="2"><v>46113.5</v></c><c r="G3" t="str"><f>A3</f><v>a, "b"</v></c></row>`,
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
      '"zip","column_2","amount","ok","date","at","column_7"',
      '"00123",true,2,,2026-04-01,2026-04-01T12:00:00,"a, ""b"""',
      '"line\ntwo",false,,,06:00:00,,',
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
