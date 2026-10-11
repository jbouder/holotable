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

/**
 * Every connection to the source was busy for as long as a checkout may wait
 * (#487). Not the query's fault and not the source's: the poller skips the
 * tick and tries again, without counting a failure or backing off, and the
 * panel says it is waiting for the source rather than showing an error.
 */
export class SourceBusyError extends Error {
  constructor(sourceId: string) {
    super(`every connection to source "${sourceId}" was busy`);
    this.name = "SourceBusyError";
  }
}
