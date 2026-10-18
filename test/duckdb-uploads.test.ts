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
import { config } from "@/lib/config";
import {
  receiveUpload,
  removeUpload,
  textProblem,
  UploadError,
  uploadsAvailability,
  uploadStem,
} from "@/lib/duckdb/uploads";
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
 * byte and file caps, the text check, the stem rules, all-or-nothing on
 * every refusal and on a cancelled request, messages that name no server
 * path, and that only an upload directory is ever removed.
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

const upload = (
  dir: string,
  files: FilePart[],
  opts: { size?: number; stopAfter?: number } = {},
) =>
  receiveUpload({
    workspaceId: "ops",
    contentType: `multipart/form-data; boundary=${BOUNDARY}`,
    body: stream(multipart(files), opts.size, opts.stopAfter),
    root: dir,
  });

/** Nothing is left under the workspace's uploads. */
function nothingKept(dir: string) {
  const ws = join(dir, "uploads", "ops");
  assert.ok(
    !existsSync(ws) || readdirSync(ws).length === 0,
    "a refused upload left files",
  );
}

async function refused(dir: string, files: FilePart[], message: RegExp, file?: string) {
  await assert.rejects(upload(dir, files), (err: unknown) => {
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

test("an upload lands under uploads/<workspace>/<fresh id>/, one CSV per file", async () => {
  const dir = root();
  const result = await upload(dir, [
    { name: "Orders.csv", body: "id,amount\n1,5\n" },
    { name: "my customers.txt", body: "id,name\n1,ada\n" },
  ]);
  assert.match(result.path, /^uploads\/ops\/[0-9a-f]{16}$/);
  assert.deepEqual(result.files, [
    { name: "orders", bytes: 14 },
    { name: "my_customers", bytes: 14 },
  ]);
  const stored = join(dir, result.path);
  assert.deepEqual(readdirSync(stored).sort(), ["my_customers.csv", "orders.csv"]);
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
    await refused(dir, [], /at least one CSV file/);
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
