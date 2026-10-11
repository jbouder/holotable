import { config } from "@/lib/config";
import { query } from "@/lib/db/pg";
import { log } from "@/lib/log";
import { recordRetentionDeleted } from "@/lib/metrics";

/**
 * The retention sweep (#494).
 *
 * The generation log, conversations and their messages each have a retention
 * period, and each is swept where it is written. A workspace nobody writes to
 * is never swept that way, so this runs the same deletes on a timer, across
 * every workspace, in bounded batches so one run never holds a long lock.
 *
 * Not the audit log: it is append-only by design (migration 012), and pruning
 * it is an operator's deliberate step (`operations/audit-log.md`), not
 * something the app may do. Not dashboard versions either: those are capped
 * when a version is written (`DASHBOARD_VERSIONS_KEEP`), since a quiet
 * dashboard never grows.
 *
 * Single-process, like the poller: every instance sweeps, and the deletes are
 * idempotent, so two instances sweeping the same rows cost a wasted query.
 */

/** Rows deleted per statement. Small enough that one batch is a short lock. */
export const RETENTION_BATCH = 1_000;

/** Statements per table per run, so a backlog is worked off over several runs. */
const MAX_BATCHES = 100;

export interface RetentionRule {
  /** The table, which is also the metric label. */
  table: string;
  /** The row's age column. */
  column: string;
  /** Days kept; 0 or less keeps rows forever and skips the table. */
  days: number;
}

/** What retention the configuration asks for, table by table. */
export function retentionRules(): RetentionRule[] {
  return [
    {
      table: "generation_log",
      column: "created_at",
      days: config.generationLogRetentionDays,
    },
    // A conversation's messages go with it (ON DELETE CASCADE); a live one's
    // old messages age out on their own.
    {
      table: "conversations",
      column: "updated_at",
      days: config.chatHistoryRetentionDays,
    },
    {
      table: "conversation_messages",
      column: "created_at",
      days: config.chatHistoryRetentionDays,
    },
  ];
}

/** Runs one statement, returning the rows it affected. Swapped in tests. */
export type RetentionQuery = (sql: string, params: unknown[]) => Promise<number>;

const run: RetentionQuery = async (sql, params) => {
  const rows = await query<{ n: number }>(sql, params);
  return rows[0]?.n ?? 0;
};

/**
 * One sweep: for each rule, delete rows past it in batches until a batch
 * comes back short. Returns how many rows each table lost. The table and
 * column names are this module's constants, never input.
 */
export async function sweepRetention(
  rules: RetentionRule[] = retentionRules(),
  execute: RetentionQuery = run,
  batch: number = RETENTION_BATCH,
): Promise<Record<string, number>> {
  const deleted: Record<string, number> = {};
  for (const rule of rules) {
    if (rule.days <= 0) continue;
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const n = await execute(
        `WITH gone AS (
           DELETE FROM ${rule.table}
           WHERE ctid = ANY(ARRAY(
             SELECT ctid FROM ${rule.table}
             WHERE ${rule.column} <= now() - make_interval(days => $1)
             LIMIT $2
           ))
           RETURNING 1
         )
         SELECT count(*)::int AS n FROM gone`,
        [rule.days, batch],
      );
      total += n;
      if (n < batch) break;
    }
    deleted[rule.table] = total;
    if (total > 0) recordRetentionDeleted(rule.table, total);
  }
  return deleted;
}

let timer: NodeJS.Timeout | null = null;

/**
 * Start the timer, once per process: the first run after one interval, each
 * later one an interval after the last finished, each jittered by up to a
 * tenth. Does nothing when `RETENTION_SWEEP_INTERVAL_MS` is 0. The timer is
 * unref'd, so it never holds a draining process open.
 */
export function startRetentionSweep(random: () => number = Math.random): void {
  const interval = config.retentionSweepIntervalMs;
  if (interval <= 0 || timer !== null) return;
  const schedule = () => {
    timer = setTimeout(
      async () => {
        const startedAt = Date.now();
        try {
          const deleted = await sweepRetention();
          log.info("retention.swept", { deleted, ms: Date.now() - startedAt });
        } catch (err) {
          log.warn("retention.sweep_failed", { err });
        }
        schedule();
      },
      interval + Math.floor(random() * interval * 0.1),
    );
    timer.unref?.();
  };
  schedule();
}

/** Stop the timer. For tests and shutdown. */
export function stopRetentionSweep(): void {
  if (timer) clearTimeout(timer);
  timer = null;
}
