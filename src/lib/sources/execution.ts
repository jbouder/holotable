import type { Truncation } from "@/lib/truncation";

/**
 * What executing a plan gives back, whatever the source's kind: the columns
 * and the rows every panel renderer already draws, or an error the author can
 * act on.
 */

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  /** Where the result was cut short (#486); absent when it is whole. */
  truncated?: Truncation;
}

/**
 * A statement failed at execution time (as opposed to a connection or
 * infrastructure failure). The message is safe to surface to an authorized
 * editor — it is the same information the live poller already forwards — and
 * routes translate it into a 400 so the user can correct the query and retry.
 */
export class QueryExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryExecutionError";
  }
}
