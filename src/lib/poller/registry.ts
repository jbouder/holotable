import type { Dashboard, Panel } from "@/lib/ir";
import { getSourceById } from "@/lib/db/repo";
import type { SourceRecord } from "@/lib/registry";
import { validateSql, buildExecutablePlan } from "@/lib/sql/safety";
import { resolveTimeRange, TimeRangeError } from "@/lib/time";
import { executePlan, QueryExecutionError } from "@/lib/timescaledb/client";
import { config } from "@/lib/config";
import { type ErrorKind, OPAQUE_MESSAGE } from "@/lib/errors";
import { log } from "@/lib/log";
import { decodeResumeToken, encodeResumeToken } from "@/lib/poller/resume";
import {
  forgetDashboard,
  observePollerTick,
  setActivePollers,
  setSseSubscribers,
} from "@/lib/metrics";

/**
 * Shared in-process dashboard poller.
 *
 * INVARIANT: exactly ONE poller runs per dashboard, shared across all
 * independently-authorized subscribers. Each subscriber opens ONE EventSource;
 * the poller executes each panel query once per tick and broadcasts deltas.
 *
 * Delta cursors: for time-series panels each SUBSCRIBER has its own cursor —
 * the newest timestamp it has been sent per panel — and is sent only newer
 * rows ("append"); the browser merges them into a bounded rolling window via
 * ECharts setOption (no chart recreation). Non-time panels are sent as full
 * "replace" snapshots. The cursors used to be the poller's, so a second viewer
 * joining a running poller, or a reconnect while someone else was watching,
 * got appends against a cursor it never had and no history (#43).
 *
 * The poller keeps the last result of every panel, so a subscriber that joins
 * is caught up at once from memory, and one that resumes with its cursors
 * (`resume.ts`, the SSE event id) is sent only what it missed.
 *
 * The metrics source is re-resolved and re-checked (tombstone) on EVERY tick,
 * so referenced-but-removed sources surface as tombstone events.
 *
 * CAVEAT: this poller is per-process. Running multiple app instances would
 * create one poller per instance. See
 * docs/src/content/docs/architecture/scaling.md for the horizontal-scaling note.
 */

export type PollerEvent =
  | {
      type: "panel";
      panelId: string;
      mode: "append" | "replace";
      columns: string[];
      rows: Record<string, unknown>[];
      /**
       * On a time-series `append`: the rows cover every timestamp from `since`
       * on, so the browser drops what it holds from `since` and appends these
       * in its place. That is how the newest bucket of a bucketed series —
       * still filling while its minute runs — is updated rather than frozen
       * at its first value. `timeField` names the column `since` applies to.
       */
      since?: string;
      timeField?: string;
    }
  | { type: "panel-error"; panelId: string; error: string; kind: ErrorKind }
  | { type: "dashboard-error"; error: string; kind: ErrorKind }
  | { type: "tombstone"; panelId: string; sourceId: string }
  | { type: "tick"; at: number };

/**
 * `id`, when present, is the SSE event id to send with the frame: the
 * subscriber's cursors after it, for resuming (#43).
 */
type Listener = (event: PollerEvent, id?: string) => void;

interface Subscriber {
  listener: Listener;
  cursors: Map<string, string>;
}

export interface TimeWindow {
  from: Date;
  to: Date;
}

/**
 * Pure delta computation. Given the full result of a query and the previous
 * cursor, returns the rows from the cursor on and the advanced cursor.
 * Exported for unit testing.
 *
 * From the cursor ON, not after it: the rows AT the cursor are sent again
 * every time. A time-bucketed series (`date_trunc('minute', ts)`) keeps
 * changing its newest bucket until the minute is over, and a cursor that
 * skipped its own timestamp froze that bucket at whatever it held when first
 * seen. The browser replaces rather than appends from the cursor
 * (`mergePanelRows`), so a re-sent row is never a duplicate.
 */
export function computeDelta(
  rows: Record<string, unknown>[],
  timeField: string,
  prevCursor: string | undefined,
): {
  fresh: Record<string, unknown>[];
  cursor: string | undefined;
  mode: "append" | "replace";
} {
  const fresh = prevCursor
    ? rows.filter((r) => String(r[timeField]) >= prevCursor)
    : rows;
  const cursor = rows.reduce<string | undefined>((acc, r) => {
    const v = String(r[timeField]);
    return acc === undefined || v > acc ? v : acc;
  }, prevCursor);
  return { fresh, cursor, mode: prevCursor ? "append" : "replace" };
}

/**
 * Executes a single panel and returns the events to broadcast.
 *
 * `dashboardWorkspaceId` is the trusted workspace identity resolved from the
 * dashboard record at poller-creation time. Every execution MUST verify that
 * the resolved source belongs to that workspace; a crafted jsonb spec that
 * names a cross-workspace sourceId is surfaced as a tombstone (indistinguishable
 * from a deleted source to prevent information disclosure).
 */
export type PanelExecutor = (
  panel: Panel,
  window: TimeWindow,
  dashboardWorkspaceId: string,
) => Promise<PollerEvent[]>;

/**
 * Factory that creates a PanelExecutor with an injectable source resolver.
 * Pass a mock resolver in tests to exercise workspace-isolation logic without
 * a live database.
 */
export function makePanelExecutor(
  getSource: (id: string) => Promise<SourceRecord | null> = getSourceById,
): PanelExecutor {
  return async (panel, window, dashboardWorkspaceId) => {
    // Re-resolve the source on every execution.
    const source = await getSource(panel.query.sourceId);

    // Tombstoned, missing, and cross-workspace sources all surface identically
    // as tombstone events so callers cannot distinguish "deleted" from "not
    // yours" — this is the single mandatory workspace-isolation enforcement
    // point for the shared poller.
    if (!source || source.tombstonedAt || source.workspaceId !== dashboardWorkspaceId) {
      return [{ type: "tombstone", panelId: panel.id, sourceId: panel.query.sourceId }];
    }

    const check = await validateSql(panel.query.sql, source.config);
    if (!check.ok) {
      return [
        {
          type: "panel-error",
          panelId: panel.id,
          error: check.error ?? "invalid sql",
          kind: "statement",
        },
      ];
    }

    const plan = buildExecutablePlan({
      sql: panel.query.sql,
      timeField: panel.query.timeField,
      from: window.from,
      to: window.to,
    });
    const result = await executePlan(source, plan);

    // The whole result, always. Each subscriber's delta is cut from it by the
    // poller, against that subscriber's own cursor.
    return [
      {
        type: "panel",
        panelId: panel.id,
        mode: "replace",
        columns: result.columns,
        rows: result.rows,
      },
    ];
  };
}

/**
 * Classify a panel failure for broadcast, honouring invariant 16 on the SSE
 * path as the query route already does on the request path.
 *
 * This used to broadcast `err.message` for anything, so a connection failure
 * put its host and port in front of every viewer of the dashboard. A statement
 * failure is the editor's to fix and keeps its real message; everything else
 * is generic, and the real cause goes to the log with the panel id on it.
 *
 * Exported for unit testing.
 */
export function describePanelError(err: unknown): { error: string; kind: ErrorKind } {
  if (err instanceof QueryExecutionError) {
    return { error: err.message, kind: "statement" };
  }
  log.error("poller.panel_failed", { err });
  return { error: OPAQUE_MESSAGE, kind: "infrastructure" };
}

/**
 * Classify a failure of the tick itself rather than of one panel.
 *
 * The time range is the only part of the spec a viewer picks, so a range that
 * will not resolve is theirs to fix and keeps its real message — the same split
 * {@link describePanelError} makes for a statement failure. Anything else that
 * breaks the loop is ours: it is opaque to the browser and the cause goes to
 * the log with the dashboard id on it.
 *
 * Exported for unit testing.
 */
export function describeTickError(
  err: unknown,
  dashboardId: string,
): { error: string; kind: ErrorKind } {
  if (err instanceof TimeRangeError) {
    log.warn("poller.time_range_failed", { dashboardId, err });
    return { error: err.message, kind: "validation" };
  }
  log.error("poller.tick_failed", { dashboardId, err });
  return { error: OPAQUE_MESSAGE, kind: "infrastructure" };
}

/** Default executor used in production. */
export const defaultPanelExecutor: PanelExecutor = makePanelExecutor();

class DashboardPoller {
  private subscribers = new Set<Subscriber>();
  /** Each panel's last result, error or tombstone: what a joiner is sent first. */
  private latest = new Map<string, PollerEvent>();
  /** The failure of the last cycle, until a cycle completes. */
  private dashboardError: PollerEvent | null = null;
  private lastTickAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;

  constructor(
    readonly dashboardId: string,
    readonly version: number,
    readonly dashboardWorkspaceId: string,
    private spec: Dashboard,
    private executor: PanelExecutor = defaultPanelExecutor,
  ) {}

  /**
   * Attach a listener. `resumeToken` is the SSE event id the browser last saw
   * (`Last-Event-ID`); when it decodes for this spec version the subscriber
   * starts from its cursors, and otherwise from nothing, which means a full
   * snapshot. Either way it is caught up at once from the last cycle, rather
   * than waiting for the next tick or being sent appends with no history.
   */
  subscribe(listener: Listener, resumeToken?: string | null): () => void {
    const resume = decodeResumeToken(
      resumeToken,
      this.version,
      new Set(this.spec.panels.map((p) => p.id)),
    );
    const sub: Subscriber = { listener, cursors: resume ?? new Map() };
    this.subscribers.add(sub);
    setSseSubscribers(this.dashboardId, this.subscribers.size);
    this.catchUp(sub);
    if (!this.running) this.start();
    return () => {
      this.subscribers.delete(sub);
      setSseSubscribers(this.dashboardId, this.subscribers.size);
      if (this.subscribers.size === 0) this.stop();
    };
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Send a new subscriber everything the last cycle produced. */
  private catchUp(sub: Subscriber) {
    for (const panel of this.spec.panels) {
      const event = this.latest.get(panel.id);
      if (event) this.deliver(sub, panel, event);
    }
    if (this.dashboardError) this.send(sub, this.dashboardError);
    else if (this.lastTickAt !== null)
      this.send(sub, { type: "tick", at: this.lastTickAt });
  }

  /**
   * One panel's event to one subscriber. A time-series result is cut down to
   * the rows newer than this subscriber's cursor, and the frame carries the
   * advanced cursors as its event id.
   */
  private deliver(sub: Subscriber, panel: Panel, event: PollerEvent) {
    const timeField = panel.query.timeField;
    if (event.type !== "panel" || !timeField) {
      this.send(sub, event);
      return;
    }
    const since = sub.cursors.get(panel.id);
    const delta = computeDelta(event.rows, timeField, since);
    if (delta.cursor !== undefined) sub.cursors.set(panel.id, delta.cursor);
    this.send(
      sub,
      delta.mode === "append"
        ? { ...event, mode: "append", rows: delta.fresh, since, timeField }
        : { ...event, mode: "replace", rows: delta.fresh },
      encodeResumeToken(this.version, sub.cursors),
    );
  }

  private send(sub: Subscriber, event: PollerEvent, id?: string) {
    try {
      sub.listener(event, id);
    } catch {
      /* listener errors must not break the loop */
    }
  }

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * A poller that is running but has neither a tick in flight nor one
   * scheduled will never tick again. The guards in `tick()` are what stop that
   * happening; this is what stops a poller it happened to anyway from being
   * handed to the next subscriber (#140), who would otherwise get a Live badge
   * over a chart that never updates.
   */
  get isStalled(): boolean {
    return this.running && !this.ticking && this.timer === null;
  }

  private start() {
    this.running = true;
    setActivePollers(registry.size);
    this.runTick();
  }

  /**
   * Start a tick from a context that cannot await it.
   *
   * `tick()` handles its own failures and reschedules in a `finally`, so this
   * handler should never fire. It exists because the previous `void this.tick()`
   * discarded the rejection instead: `void` marks a deliberate fire-and-forget,
   * it does not make one safe, and a discarded rejection here means the loop
   * stops for every viewer of the dashboard with nothing logged and nothing
   * sent (#140).
   */
  private runTick(): void {
    this.tick().catch((err) => {
      log.error("poller.tick_crashed", { dashboardId: this.dashboardId, err });
      this.scheduleNext();
    });
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [key, poller] of registry) {
      if (poller === this) {
        registry.delete(key);
        break;
      }
    }
    // Stop exporting a dashboard nobody is watching, rather than leaving its
    // gauge pinned at zero for the life of the process.
    forgetDashboard(this.dashboardId);
    setActivePollers(registry.size);
  }

  private broadcast(event: PollerEvent) {
    for (const sub of this.subscribers) this.send(sub, event);
  }

  /** A panel's outcome for this cycle: remembered, then sent to everyone. */
  private publish(panel: Panel, event: PollerEvent) {
    this.latest.set(panel.id, event);
    for (const sub of this.subscribers) this.deliver(sub, panel, event);
  }

  private scheduleNext() {
    if (!this.running || this.subscribers.size === 0) return;
    // Called from a `finally` and from the crash handler above, so it cannot
    // assume it runs once per tick: a second live timer would double the
    // dashboard's query rate for the life of the poller.
    if (this.timer) clearTimeout(this.timer);
    const interval = Math.max(config.minRefreshIntervalMs, this.spec.refreshIntervalMs);
    this.timer = setTimeout(() => this.runTick(), interval);
  }

  /**
   * One cycle: resolve the window, execute every panel, broadcast, reschedule.
   *
   * Everything outside the per-panel `try` used to be unguarded, and
   * `resolveTimeRange` throws on a range that is inverted or unparseable — a
   * range a viewer can select. The rejection was discarded, `scheduleNext()`
   * never ran, and the poller stayed in the registry ticking for nobody (#140).
   * So the whole body is guarded and the reschedule is in a `finally`: a
   * failure is broadcast, logged, and retried on the next interval rather than
   * ending the loop.
   */
  private async tick() {
    if (!this.running) return;
    this.ticking = true;
    try {
      const startedAt = performance.now();
      const window = resolveTimeRange(this.spec.timeRange);
      await Promise.all(
        this.spec.panels.map(async (p) => {
          try {
            const events = await this.executor(p, window, this.dashboardWorkspaceId);
            for (const e of events) this.publish(p, e);
          } catch (err) {
            this.publish(p, {
              type: "panel-error",
              panelId: p.id,
              ...describePanelError(err),
            });
          }
        }),
      );
      // Every panel is executed and broadcast by this point, so the tick's cost
      // is the whole cycle — not one query — which is what a refresh interval
      // has to accommodate.
      observePollerTick(this.dashboardId, (performance.now() - startedAt) / 1000);
      // Only on a completed cycle: `tick` is what the viewer's freshness
      // readout and staleness watchdog run on, so a failed cycle must not
      // refresh it.
      this.dashboardError = null;
      this.lastTickAt = Date.now();
      this.broadcast({ type: "tick", at: this.lastTickAt });
    } catch (err) {
      this.dashboardError = {
        type: "dashboard-error",
        ...describeTickError(err, this.dashboardId),
      };
      this.broadcast(this.dashboardError);
    } finally {
      this.ticking = false;
      this.scheduleNext();
    }
  }
}

const registry = new Map<string, DashboardPoller>();

/**
 * Get the shared poller for a dashboard and time range, creating it if needed.
 * If a poller exists for an older version, it is replaced so the new spec takes
 * effect. Distinct viewer-selected ranges are isolated from each other.
 *
 * `workspaceId` is the trusted dashboard workspace identity resolved from the
 * database record. It is stored on the poller and passed to every panel
 * execution so sources are always validated against the dashboard workspace,
 * regardless of subscriber identity.
 */
export function getPoller(
  dashboardId: string,
  version: number,
  workspaceId: string,
  spec: Dashboard,
  executor: PanelExecutor = defaultPanelExecutor,
): DashboardPoller {
  const key = JSON.stringify([dashboardId, spec.timeRange.from, spec.timeRange.to]);
  const existing = registry.get(key);
  if (existing?.isStalled) {
    // Sharing it would hand this subscriber a poller that never ticks again.
    log.warn("poller.stalled_replaced", { dashboardId, version: existing.version });
    existing.stop();
  } else if (existing) {
    if (existing.version >= version) return existing;
    existing.stop();
  }
  const poller = new DashboardPoller(dashboardId, version, workspaceId, spec, executor);
  registry.set(key, poller);
  return poller;
}

/** Drop a poller (e.g. after a new version is saved). */
export function invalidatePoller(dashboardId: string): void {
  for (const poller of registry.values()) {
    if (poller.dashboardId === dashboardId) poller.stop();
  }
}

/**
 * Stop every poller. Graceful shutdown (#47) calls this once the drain flag is
 * set, so no new metric query is issued while the process waits out the ones
 * already running. Subscribers are closed separately, by the stream route's
 * drain hook.
 */
export function stopAllPollers(): void {
  // `stop()` removes the poller from the registry, so iterate a snapshot.
  for (const poller of [...registry.values()]) poller.stop();
}

/** Test/introspection helper. */
export function activePollerCount(): number {
  return registry.size;
}

export { DashboardPoller };
