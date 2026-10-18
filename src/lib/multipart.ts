/**
 * A streaming `multipart/form-data` reader (#595), for the one route that
 * takes files from a browser: `POST /api/sources/duckdb/uploads`.
 *
 * `Request.formData()` buffers every part in memory before the handler sees
 * any of it, so a route with a byte cap could only enforce it after the
 * whole upload had been held. This reads the body chunk by chunk and hands
 * each part's bytes to a sink as they arrive, awaiting the sink before
 * reading on, so a slow disk pushes back on the socket and a refusal stops
 * the read at once. Nothing here holds more than one chunk plus a delimiter.
 *
 * The body is untrusted: a part's headers are capped, a body that ends
 * before its closing delimiter is refused, and every refusal is a
 * {@link MultipartError} whose message quotes nothing from the request.
 */

/** A malformed or over-large multipart body. Its message quotes nothing it read. */
export class MultipartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MultipartError";
  }
}

/** What a part's headers said. */
export interface MultipartPart {
  /** The form field's name. */
  name: string;
  /** The file name the browser sent, or null for a plain field. */
  filename: string | null;
  /** The part's `Content-Type`, or null. Advisory only: never trusted. */
  contentType: string | null;
}

/** Where a part's bytes go. Each call is awaited before the body is read on. */
export interface PartSink {
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
}

export interface MultipartLimits {
  /** The most parts the body may carry. */
  maxParts: number;
  /** The most bytes one part's headers may take. */
  maxHeaderBytes?: number;
}

const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");
const DEFAULT_MAX_HEADER_BYTES = 8 * 1024;
/** The bytes allowed before the first boundary (a preamble), which is ignored. */
const MAX_PREAMBLE_BYTES = 1024;

/**
 * The boundary of a `multipart/form-data` content type, or null when the type
 * is anything else or the boundary is not one RFC 2046 allows.
 */
export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const [type, ...params] = contentType.split(";");
  if (type?.trim().toLowerCase() !== "multipart/form-data") return null;
  for (const param of params) {
    const eq = param.indexOf("=");
    if (eq < 0) continue;
    if (param.slice(0, eq).trim().toLowerCase() !== "boundary") continue;
    let value = param.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    return /^[0-9A-Za-z'()+_,\-./:=? ]{1,70}$/.test(value) && !value.endsWith(" ")
      ? value
      : null;
  }
  return null;
}

/** A header's parameters (`name="files"; filename="a.csv"`), lowercased keys. */
function headerParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  const pattern = /;\s*([^\s=;]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/g;
  for (const m of value.matchAll(pattern)) {
    const key = m[1]?.toLowerCase();
    if (!key || params.has(key)) continue;
    const raw = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : (m[3] ?? "").trim();
    params.set(key, raw);
  }
  return params;
}

/** RFC 5987 `filename*=UTF-8''…`, decoded, or null. */
function extendedFilename(value: string | undefined): string | null {
  if (!value) return null;
  const m = /^utf-8'[^']*'(.*)$/i.exec(value);
  if (!m?.[1]) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}

function parseHeaders(block: Buffer): MultipartPart {
  const text = new TextDecoder("utf-8").decode(block);
  let disposition: string | null = null;
  let contentType: string | null = null;
  for (const line of text.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new MultipartError("a part has a malformed header");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "content-disposition") disposition = value;
    else if (name === "content-type") contentType = value;
  }
  if (!disposition || !/^form-data\s*(;|$)/i.test(disposition)) {
    throw new MultipartError("a part is not form-data");
  }
  const params = headerParams(disposition);
  const name = params.get("name");
  if (name === undefined) throw new MultipartError("a part has no field name");
  const filename = extendedFilename(params.get("filename*")) ?? params.get("filename");
  return { name, filename: filename ?? null, contentType };
}

/**
 * Read a `multipart/form-data` body, handing each part to the sink `onPart`
 * returns, in order. Resolves once the closing delimiter has been read; the
 * epilogue after it is not read. Throws a {@link MultipartError} for a body
 * that is malformed, has too many parts or ends early, and rethrows whatever
 * a sink throws, after cancelling the body either way.
 */
export async function readMultipart(
  body: ReadableStream<Uint8Array> | null,
  boundary: string,
  onPart: (part: MultipartPart) => Promise<PartSink>,
  limits: MultipartLimits,
): Promise<void> {
  if (!body) throw new MultipartError("the request has no body");
  const maxHeaderBytes = limits.maxHeaderBytes ?? DEFAULT_MAX_HEADER_BYTES;
  const first = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const reader = body.getReader();

  type State = "preamble" | "boundary" | "headers" | "body";
  let state: State = "preamble";
  let buffer = Buffer.alloc(0);
  let sink: PartSink | null = null;
  let parts = 0;
  let finished = false;

  try {
    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer = buffer.length === 0 ? Buffer.from(value) : Buffer.concat([buffer, value]);

      // Consume as much of the buffer as the state machine can.
      for (;;) {
        if (state === "preamble") {
          const at = buffer.indexOf(first);
          if (at < 0) {
            if (buffer.length > MAX_PREAMBLE_BYTES + first.length) {
              throw new MultipartError("the body does not start with its boundary");
            }
            break;
          }
          if (at > MAX_PREAMBLE_BYTES) {
            throw new MultipartError("the body does not start with its boundary");
          }
          buffer = buffer.subarray(at + first.length);
          state = "boundary";
        }
        if (state === "boundary") {
          if (buffer.length < 2) break;
          if (buffer[0] === 0x2d && buffer[1] === 0x2d) {
            finished = true;
            break;
          }
          if (!buffer.subarray(0, 2).equals(CRLF)) {
            throw new MultipartError("a boundary is not followed by a line break");
          }
          buffer = buffer.subarray(2);
          state = "headers";
        }
        if (state === "headers") {
          const at = buffer.indexOf(HEADER_END);
          if (at < 0) {
            if (buffer.length > maxHeaderBytes) {
              throw new MultipartError("a part's headers are too large");
            }
            break;
          }
          if (at > maxHeaderBytes) {
            throw new MultipartError("a part's headers are too large");
          }
          parts += 1;
          if (parts > limits.maxParts) {
            throw new MultipartError(`the body has more than ${limits.maxParts} parts`);
          }
          const part = parseHeaders(buffer.subarray(0, at));
          buffer = buffer.subarray(at + HEADER_END.length);
          sink = await onPart(part);
          state = "body";
        }
        if (state === "body") {
          const at = buffer.indexOf(delimiter);
          if (at < 0) {
            // Keep what could be the start of a delimiter split across reads.
            const safe = buffer.length - (delimiter.length - 1);
            if (safe > 0) {
              await sink?.write(buffer.subarray(0, safe));
              buffer = Buffer.from(buffer.subarray(safe));
            }
            break;
          }
          if (at > 0) await sink?.write(buffer.subarray(0, at));
          await sink?.end();
          sink = null;
          buffer = buffer.subarray(at + delimiter.length);
          state = "boundary";
        }
      }
    }
    if (!finished) throw new MultipartError("the body ended before its closing boundary");
  } finally {
    // The epilogue, or the rest of a refused body, is never read.
    await reader.cancel().catch(() => {});
  }
}
