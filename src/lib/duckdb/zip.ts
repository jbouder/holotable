import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createInflateRaw } from "node:zlib";

/**
 * Just enough of a ZIP reader for an uploaded `.xlsx` (#597): the central
 * directory of a file on disk, and one entry at a time inflated as a stream
 * through Node's own zlib, never held whole.
 *
 * The archive is untrusted. Its directory is bounded in entries, an entry
 * may be stored or deflated and nothing else, an encrypted entry, a ZIP64
 * archive and a name given twice are refused, and every entry is read
 * against a cap on the bytes it inflates to, counted as they come out: an
 * archive that claims small sizes and inflates without end stops at the
 * cap. Every message is about the archive, never a path.
 */

/** A malformed, unsupported or over-large archive. */
export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

/** The most entries a workbook's archive may list. */
export const MAX_ZIP_ENTRIES = 10_000;

/** One file in the archive, as its central directory lists it. */
export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const MAX_COMMENT = 0xffff;

/** The archive's entries by name. */
export async function readZipDirectory(file: string): Promise<Map<string, ZipEntry>> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (size < EOCD_MIN) throw new ZipError("it is not a ZIP archive");
    const tailLength = Math.min(size, EOCD_MIN + MAX_COMMENT);
    const tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    let at = -1;
    for (let i = tailLength - EOCD_MIN; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new ZipError("it is not a ZIP archive");
    const count = tail.readUInt16LE(at + 10);
    const cdSize = tail.readUInt32LE(at + 12);
    const cdOffset = tail.readUInt32LE(at + 16);
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      throw new ZipError("it is a ZIP64 archive, which is not read");
    }
    if (count > MAX_ZIP_ENTRIES) {
      throw new ZipError(`its archive lists more than ${MAX_ZIP_ENTRIES} entries`);
    }
    if (cdOffset + cdSize > size)
      throw new ZipError("its archive directory is cut short");
    const cd = Buffer.alloc(cdSize);
    await handle.read(cd, 0, cdSize, cdOffset);

    const entries = new Map<string, ZipEntry>();
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) {
        throw new ZipError("its archive directory is malformed");
      }
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const compressedSize = cd.readUInt32LE(p + 20);
      const nameLength = cd.readUInt16LE(p + 28);
      const extraLength = cd.readUInt16LE(p + 30);
      const commentLength = cd.readUInt16LE(p + 32);
      const localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLength > cd.length) {
        throw new ZipError("its archive directory is malformed");
      }
      const name = cd.toString("utf8", p + 46, p + 46 + nameLength);
      p += 46 + nameLength + extraLength + commentLength;
      if (flags & 0x1) {
        throw new ZipError("it is encrypted; remove its password and upload it again");
      }
      if (entries.has(name)) throw new ZipError("its archive names one entry twice");
      entries.set(name, { name, method, compressedSize, localOffset });
    }
    return entries;
  } finally {
    await handle.close();
  }
}

/**
 * Stream one entry's bytes, inflated, to `onChunk`, refusing past `maxBytes`
 * inflated. `onChunk` is awaited for each chunk in order (a slow writer
 * pushes back on the read) and may throw to stop it.
 */
export async function readZipEntry(
  file: string,
  entry: ZipEntry,
  maxBytes: number,
  onChunk: (chunk: Buffer) => void | Promise<void>,
): Promise<void> {
  if (entry.method !== 0 && entry.method !== 8) {
    throw new ZipError("it uses a compression method that is not read");
  }
  const handle = await open(file, "r");
  let start: number;
  try {
    const header = Buffer.alloc(30);
    const { bytesRead } = await handle.read(header, 0, 30, entry.localOffset);
    if (bytesRead < 30 || header.readUInt32LE(0) !== LOCAL) {
      throw new ZipError("an entry of its archive is malformed");
    }
    start = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  } finally {
    await handle.close();
  }
  const source =
    entry.compressedSize === 0
      ? Readable.from([])
      : createReadStream(/* turbopackIgnore: true */ file, {
          start,
          end: start + entry.compressedSize - 1,
        });
  let total = 0;
  // What stopped the read from inside: the pipeline itself rejects with the
  // abort that follows, so the reason is kept here.
  let stopped: unknown = null;
  const sink = async (chunks: AsyncIterable<Buffer>) => {
    try {
      for await (const chunk of chunks) {
        total += chunk.length;
        if (total > maxBytes) {
          throw new ZipError(`a part of it inflates past ${maxBytes} bytes`);
        }
        await onChunk(chunk);
      }
    } catch (err) {
      stopped ??= err;
      throw err;
    }
  };
  try {
    if (entry.method === 8) await pipeline(source, createInflateRaw(), sink);
    else await pipeline(source, sink);
  } catch (err) {
    if (stopped) throw stopped;
    if (err instanceof ZipError) throw err;
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      String(err.code).startsWith("Z_")
    ) {
      throw new ZipError("an entry of its archive does not inflate");
    }
    throw err;
  }
}
