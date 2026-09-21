/**
 * Byte-size cap on query results.
 *
 * `LIMIT maxQueryRows` bounds how many rows a query may return, but row count
 * is a poor proxy for memory: 5000 rows of a wide table with text columns can
 * be hundreds of megabytes, and that payload is buffered by the server,
 * serialized into an SSE frame, and held in browser state. The collector
 * measures each row as it arrives from Postgres and stops accumulating the
 * moment the cap is crossed, so a result too large to send is never fully
 * materialized.
 */

const MIB = 1024 * 1024;

/** Human-readable size for messages: `4 MiB`, `512 KiB`, `900 B`. */
export function formatBytes(bytes: number): string {
  if (bytes >= MIB && bytes % MIB === 0) return `${bytes / MIB} MiB`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/**
 * A row's size as the JSON the client will receive, in UTF-8 bytes. This is
 * what actually crosses the wire and sits in browser state, so it is the
 * quantity the cap should bound; the small per-row overhead of the framing
 * array is ignored.
 */
export function serializedRowBytes(row: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(row), "utf8");
}

/**
 * Accumulates rows until their serialized size would exceed `maxBytes`.
 * `push` returns `false` once the cap is crossed; the offending row is not
 * kept and later rows are ignored, so memory stays bounded by the cap plus
 * one row regardless of how many more rows the server sends.
 */
export class ResultCollector {
  readonly rows: Record<string, unknown>[] = [];
  /** Serialized bytes of the rows kept so far. */
  bytes = 0;
  /** Rows seen, including the one that crossed the cap and any after it. */
  seen = 0;
  private overflow = false;

  constructor(readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error(`maxBytes must be a positive number, got ${maxBytes}`);
    }
  }

  /** Whether the cap has been crossed. */
  get exceeded(): boolean {
    return this.overflow;
  }

  push(row: Record<string, unknown>): boolean {
    this.seen += 1;
    if (this.overflow) return false;
    const size = serializedRowBytes(row);
    if (this.bytes + size > this.maxBytes) {
      this.overflow = true;
      return false;
    }
    this.bytes += size;
    this.rows.push(row);
    return true;
  }

  /**
   * The message routes surface as a 400 when the cap is crossed: it names the
   * limit and the variable that sets it, and says what to change in the query.
   */
  exceededMessage(): string {
    const kept = this.rows.length;
    return (
      `result exceeds the MAX_RESULT_BYTES limit of ${formatBytes(this.maxBytes)}: ` +
      `the first ${kept} row${kept === 1 ? "" : "s"} already serialize to ` +
      `${formatBytes(this.bytes)} and the query returned more. ` +
      `Narrow the time range, aggregate with time_bucket(), or select fewer columns.`
    );
  }
}
