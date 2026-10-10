/**
 * The demo seeder's synthetic rows, as pure functions (#252).
 *
 * `scripts/seed.ts` inserts what these produce, live every `SEED_INTERVAL_MS`
 * and, with `SEED_BACKFILL`, once across a past window before the loop starts.
 * Nothing here touches a database, so `test/seed-data.test.ts` can check row
 * counts and timestamps without one. The live loop and the backfill share the
 * generators, so the history looks exactly like what streams after it.
 */

export const SERVICES = ["api", "web", "worker"];
export const ROUTES = ["/login", "/checkout", "/search", "/profile", "/health"];
export const HOSTS = ["host-01", "host-02", "host-03", "host-04"];
export const REGIONS = ["us-east", "us-west", "eu-central"];

/** Rows per live batch of `metrics.http_requests`. */
export const HTTP_ROWS_PER_BATCH = 50;
/** The largest multi-row insert the backfill sends. */
export const BACKFILL_CHUNK_ROWS = 5_000;
/**
 * The longest backfill accepted. A week at the default 2 s cadence is already
 * about 15 million request rows; anything longer is a typo, not a demo.
 */
export const MAX_BACKFILL_MS = 7 * 24 * 3_600_000;

export interface HttpRequestRow {
  ts: Date;
  service: string;
  route: string;
  status: number;
  duration_ms: number;
  bytes: number;
}

export interface SystemMetricRow {
  ts: Date;
  host: string;
  region: string;
  cpu_pct: number;
  mem_pct: number;
  disk_pct: number;
  net_in_bytes: number;
  net_out_bytes: number;
}

export type Random = () => number;

/** How far before its batch time a row may land; the live loop has always used 1 s. */
const SPREAD_MS = 1_000;

function pick<T>(items: readonly T[], random: Random): T {
  return items[Math.floor(random() * items.length)];
}

/**
 * One batch of request events at `at` (epoch ms): each row lands up to a
 * second before it, and never before `floor` when one is given.
 */
export function httpRequestRows(
  at: number,
  random: Random = Math.random,
  floor = Number.NEGATIVE_INFINITY,
): HttpRequestRow[] {
  return Array.from({ length: HTTP_ROWS_PER_BATCH }, () => {
    const roll = random();
    const status = roll < 0.9 ? 200 : roll < 0.97 ? 404 : 500;
    return {
      ts: new Date(Math.max(floor, at - Math.floor(random() * SPREAD_MS))),
      service: pick(SERVICES, random),
      route: pick(ROUTES, random),
      status,
      duration_ms: Math.max(1, 40 + random() * 200 + (status >= 500 ? 300 : 0)),
      bytes: Math.floor(200 + random() * 20000),
    };
  });
}

/**
 * Each host's CPU and disk range, `[low, high]` percent (#404). Distinct on
 * purpose, so the demo's thresholds and states have something to show: one
 * quiet host, one that is busy and now and then hot, one whose disk is
 * filling. Indexed like {@link HOSTS}.
 */
const HOST_PROFILES = [
  { cpu: [20, 50], disk: [40, 55] },
  { cpu: [45, 75], disk: [60, 72] },
  { cpu: [72, 98], disk: [70, 80] },
  { cpu: [30, 60], disk: [86, 94] },
] as const satisfies readonly { cpu: [number, number]; disk: [number, number] }[];

function within([low, high]: readonly [number, number], random: Random): number {
  return Math.min(100, Math.max(1, low + random() * (high - low)));
}

/** One reading per host at `at`, so every host stays present in each window. */
export function systemMetricRows(
  at: number,
  random: Random = Math.random,
  floor = Number.NEGATIVE_INFINITY,
): SystemMetricRow[] {
  return HOSTS.map((host, index) => ({
    ts: new Date(Math.max(floor, at - Math.floor(random() * SPREAD_MS))),
    host,
    region: REGIONS[index % REGIONS.length],
    cpu_pct: within(HOST_PROFILES[index % HOST_PROFILES.length].cpu, random),
    mem_pct: Math.min(100, Math.max(1, 40 + random() * 40)),
    disk_pct: within(HOST_PROFILES[index % HOST_PROFILES.length].disk, random),
    net_in_bytes: Math.floor(10_000 + random() * 5_000_000),
    net_out_bytes: Math.floor(10_000 + random() * 5_000_000),
  }));
}

const DURATION = /^(\d+)(s|m|h|d)$/;
const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * `SEED_BACKFILL` as milliseconds: `30m`, `6h`, `1d`. Unset or empty is
 * `null`, meaning no backfill. Anything else throws a message that names the
 * variable, for the seeder to print before it exits 1.
 */
export function parseBackfill(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const match = DURATION.exec(raw.trim());
  if (!match) {
    throw new Error(
      `SEED_BACKFILL must be a duration such as 30m, 6h or 1d (got "${raw}").`,
    );
  }
  const ms = Number(match[1]) * UNIT_MS[match[2]];
  if (ms <= 0) throw new Error("SEED_BACKFILL must be longer than zero.");
  if (ms > MAX_BACKFILL_MS) {
    throw new Error(`SEED_BACKFILL is at most 7d (got "${raw}").`);
  }
  return ms;
}

/**
 * The batch times a backfill covers: one every `intervalMs`, walking back from
 * one interval before `now` (the live loop's first batch is at `now`) to the
 * start of the range, oldest first.
 */
export function backfillBatchTimes(
  fromMs: number,
  nowMs: number,
  intervalMs: number,
): number[] {
  if (!(intervalMs > 0) || fromMs >= nowMs) return [];
  const times: number[] = [];
  for (let at = nowMs - intervalMs; at >= fromMs; at -= intervalMs) times.push(at);
  return times.reverse();
}

/**
 * Where a backfill starts: the window start, or just after the newest row
 * already there, whichever is later. A restart on a mounted volume therefore
 * fills only the gap it was down for, and never doubles the history.
 */
export function backfillStart(
  windowMs: number,
  nowMs: number,
  newestExistingMs: number | null,
): number {
  const windowStart = nowMs - windowMs;
  if (newestExistingMs === null) return windowStart;
  return Math.max(windowStart, newestExistingMs + 1);
}

/**
 * The rows of a backfill in chunks of at most `chunkRows`, without holding the
 * whole history in memory. Every row's timestamp is inside `[fromMs, nowMs)`.
 */
export function* backfillChunks<T>(
  make: (at: number, random: Random, floor: number) => T[],
  fromMs: number,
  nowMs: number,
  intervalMs: number,
  chunkRows = BACKFILL_CHUNK_ROWS,
  random: Random = Math.random,
): Generator<T[]> {
  let chunk: T[] = [];
  for (const at of backfillBatchTimes(fromMs, nowMs, intervalMs)) {
    for (const row of make(at, random, fromMs)) {
      chunk.push(row);
      if (chunk.length === chunkRows) {
        yield chunk;
        chunk = [];
      }
    }
  }
  if (chunk.length > 0) yield chunk;
}
