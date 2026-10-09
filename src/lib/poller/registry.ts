import { type Dashboard, hasQuery, panelRefreshMs, type QueryPanel } from "@/lib/ir";
import { getSourceById } from "@/lib/db/repo";
import type { SourceRecord } from "@/lib/registry";
import type { ExecutablePlan } from "@/lib/sql/safety";
import { RowFilterDenied, RowFilterError } from "@/lib/sql/row-filter";
import { VariableError, type VariableValues } from "@/lib/sql/variables";
import { valuesKey } from "@/lib/variable-selection";
import { rowFilterInScope, type RowScope } from "@/lib/row-scope";
import { resolveTimeRange, TimeRangeError } from "@/lib/time";
import { QueryExecutionError } from "@/lib/sources/execution";
import { serverKind } from "@/lib/sources/server/registry";
import { config } from "@/lib/config";
import { type ErrorKind, OPAQUE_MESSAGE } from "@/lib/errors";
import { log } from "@/lib/log";
import {
  type BackoffPolicy,
  canRetryNow,
  isDue,
  type PanelHealth,
  recordFailure,
} from "@/lib/poller/backoff";
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
      /**
       * The window these rows were selected over (epoch ms). The tick's
       * window is the dashboard's; a panel with its own (#114) ends here.
       */
      window?: { from: number; to: number };
    }
  | { type: "panel-error"; panelId: string; error: string; kind: ErrorKind }
  /**
   * The panel has failed `failures` times in a row and is not run again until
   * `retryAt` (epoch ms), unless a viewer retries it sooner (#44). `error` and
   * `kind` are the last failure's, classified as for `panel-error`.
   */
  | {
      type: "panel-degraded";
      panelId: string;
      error: string;
      kind: ErrorKind;
      failures: number;
      retryAt: number;
    }
  | { type: "dashboard-error"; error: string; kind: ErrorKind }
  | { type: "tombstone"; panelId: string; sourceId: string }
  /**
   * A completed cycle. `window` is the range that cycle ran over, as the
   * server resolved it (epoch ms): a panel that draws up to "now" — a state
   * timeline's open span (#201) — ends at the server's `to`, never at the
   * viewer's clock.
   */
  | { type: "tick"; at: number; window?: { from: number; to: number } };

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
 *
 * `scope` is the claim values this poller's subscribers share (#31); a
 * row-filtered source is narrowed to the rows they match, and a panel whose
 * source needs a claim the scope lacks is refused, never run unfiltered.
 *
 * `variables` is the values this poller's subscribers selected (#67), already
 * checked against what each variable allows: one for every variable the
 * dashboard declares, so its names are the declared ones. They are bound as
 * parameters, never written into the statement.
 */
export type PanelExecutor = (
  panel: QueryPanel,
  window: TimeWindow,
  dashboardWorkspaceId: string,
  scope: RowScope,
  variables: VariableValues,
) => Promise<PollerEvent[]>;

/**
 * Factory that creates a PanelExecutor with an injectable source resolver.
 * Pass a mock resolver in tests to exercise workspace-isolation logic without
 * a live database.
 */
export function makePanelExecutor(
  getSource: (id: string) => Promise<SourceRecord | null> = getSourceById,
): PanelExecutor {
  return async (panel, window, dashboardWorkspaceId, scope, variables) => {
    // Re-resolve the source on every execution.
    const source = await getSource(panel.query.sourceId);

    // Tombstoned, missing, and cross-workspace sources all surface identically
    // as tombstone events so callers cannot distinguish "deleted" from "not
    // yours" — this is the single mandatory workspace-isolation enforcement
    // point for the shared poller.
    if (!source || source.tombstonedAt || source.workspaceId !== dashboardWorkspaceId) {
      return [{ type: "tombstone", panelId: panel.id, sourceId: panel.query.sourceId }];
    }

    const kind = serverKind(source);
    const check = await kind.validate(
      panel.query.sql,
      source.config,
      new Set(Object.keys(variables)),
    );
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

    let plan: ExecutablePlan;
    try {
      plan = kind.plan({
        sql: panel.query.sql,
        timeField: panel.query.timeField,
        from: window.from,
        to: window.to,
        // Re-bound every tick from the source as it is now, so a filter
        // added since the poller started applies at once.
        rowFilter: rowFilterInScope(source, scope),
        variables,
      });
    } catch (err) {
      if (err instanceof RowFilterDenied) {
        return [
          {
            type: "panel-error",
            panelId: panel.id,
            error: "You have no access to this source's rows.",
            kind: "authorization",
          },
        ];
      }
      if (err instanceof RowFilterError || err instanceof VariableError) {
        return [
          {
            type: "panel-error",
            panelId: panel.id,
            error: err.message,
            kind: "statement",
          },
        ];
      }
      throw err;
    }
    const result = await kind.execute(source, plan);

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

/** The backoff policy from `POLLER_FAILURE_THRESHOLD` and `POLLER_MAX_BACKOFF_MS`. */
export function configuredBackoff(): BackoffPolicy {
  return { threshold: config.pollerFailureThreshold, maxMs: config.pollerMaxBackoffMs };
}

class DashboardPoller {
  private subscribers = new Set<Subscriber>();
  /** Each panel's last result, error or tombstone: what a joiner is sent first. */
  private latest = new Map<string, PollerEvent>();
  /** The failure of the last cycle, until a cycle completes. */
  private dashboardError: PollerEvent | null = null;
  /** The last completed cycle's `tick`, which a joiner is sent. */
  private lastTick: Extract<PollerEvent, { type: "tick" }> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticking = false;
  /** Panels whose last execution failed (#44). A healthy panel has no entry. */
  private health = new Map<string, PanelHealth>();
  /** Panels executing right now, so a tick and a manual retry never overlap. */
  private executing = new Set<string>();
  /**
   * When each cadence is next due (epoch ms), keyed by its interval (#114).
   * Panels that share an interval run together, so the loop is one timer for
   * the dashboard however many panels have their own.
   */
  private nextDue = new Map<number, number>();
  /** When the pending timer was set to fire for (epoch ms). */
  private scheduledFor = 0;

  constructor(
    readonly dashboardId: string,
    readonly version: number,
    readonly dashboardWorkspaceId: string,
    private spec: Dashboard,
    private readonly scope: RowScope = {},
    private executor: PanelExecutor = defaultPanelExecutor,
    private readonly backoff: BackoffPolicy = configuredBackoff(),
    private readonly variables: VariableValues = {},
  ) {}

  /** The dashboard's refresh interval, never below the server's floor. */
  private get intervalMs(): number {
    return Math.max(config.minRefreshIntervalMs, this.spec.refreshIntervalMs);
  }

  /** A panel's own interval or the dashboard's, never below the server's floor. */
  private intervalOf(panel: QueryPanel): number {
    return Math.max(
      config.minRefreshIntervalMs,
      panelRefreshMs(panel, this.spec.refreshIntervalMs),
    );
  }

  /**
   * The intervals this dashboard runs on: one per distinct panel cadence, or
   * the dashboard's own when nothing runs a query, which still ticks.
   */
  private cadences(): number[] {
    const set = new Set(this.spec.panels.filter(hasQuery).map((p) => this.intervalOf(p)));
    return set.size > 0 ? [...set] : [this.intervalMs];
  }

  /**
   * The cadences to run now. One due within a quarter of its interval (and at
   * most a second) is run with this cycle rather than on a timer of its own,
   * so a 15s and a 30s cadence that drifted apart by a query's duration are
   * still one cycle every 30 seconds rather than two.
   */
  private dueCadences(now: number): Set<number> {
    return new Set(
      this.cadences().filter((c) => {
        const due = this.nextDue.get(c);
        return due === undefined || due - now <= Math.min(1_000, c / 4);
      }),
    );
  }

  /**
   * The window a panel is run over (#114): its own when it has one, resolved
   * here like the dashboard's, or the dashboard's for this cycle.
   */
  private windowFor(panel: QueryPanel, shown: TimeWindow): TimeWindow {
    return panel.timeRange ? resolveTimeRange(panel.timeRange) : shown;
  }

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
    for (const panel of this.spec.panels.filter(hasQuery)) {
      const event = this.latest.get(panel.id);
      if (event) this.deliver(sub, panel, event);
    }
    if (this.dashboardError) this.send(sub, this.dashboardError);
    else if (this.lastTick !== null) this.send(sub, this.lastTick);
  }

  /**
   * One panel's event to one subscriber. A time-series result is cut down to
   * the rows newer than this subscriber's cursor, and the frame carries the
   * advanced cursors as its event id.
   */
  private deliver(sub: Subscriber, panel: QueryPanel, event: PollerEvent) {
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
  private publish(panel: QueryPanel, event: PollerEvent) {
    this.latest.set(panel.id, event);
    for (const sub of this.subscribers) this.deliver(sub, panel, event);
  }

  private scheduleNext() {
    if (!this.running || this.subscribers.size === 0) return;
    // Called from a `finally` and from the crash handler above, so it cannot
    // assume it runs once per tick: a second live timer would double the
    // dashboard's query rate for the life of the poller.
    if (this.timer) clearTimeout(this.timer);
    // The earliest cadence due. One that never completed (a crashed tick)
    // waits its interval, as the whole dashboard used to.
    const now = Date.now();
    const delay = Math.min(
      ...this.cadences().map((c) => Math.max(0, (this.nextDue.get(c) ?? now + c) - now)),
    );
    this.scheduledFor = now + delay;
    this.timer = setTimeout(() => this.runTick(), delay);
  }

  /**
   * Execute one panel and publish what came of it.
   *
   * Never rejects. A thrown failure is counted against the panel (#44): under
   * the threshold it is broadcast as a `panel-error` as before, and from the
   * threshold on as a `panel-degraded` carrying when the panel runs next. What
   * the executor returns, including a refusal it reports as a `panel-error`
   * (an invalid statement, a missing row-filter claim), clears the count:
   * those never reached the source, so they put no load on it to back off from.
   */
  private async runPanel(panel: QueryPanel, shown: TimeWindow): Promise<void> {
    let window: TimeWindow;
    try {
      window = this.windowFor(panel, shown);
    } catch (err) {
      // A window of its own that will not resolve is the author's to fix, and
      // is this panel's alone: the rest of the cycle runs.
      this.publish(panel, {
        type: "panel-error",
        panelId: panel.id,
        ...describeTickError(err, this.dashboardId),
      });
      return;
    }
    this.executing.add(panel.id);
    const startedAt = Date.now();
    try {
      const events = await this.executor(
        panel,
        window,
        this.dashboardWorkspaceId,
        this.scope,
        this.variables,
      );
      this.health.delete(panel.id);
      const span = { from: window.from.getTime(), to: window.to.getTime() };
      for (const e of events) {
        this.publish(panel, e.type === "panel" ? { ...e, window: span } : e);
      }
    } catch (err) {
      const described = describePanelError(err);
      const health = recordFailure(
        this.health.get(panel.id),
        startedAt,
        Date.now(),
        this.intervalOf(panel),
        this.backoff,
      );
      this.health.set(panel.id, health);
      if (health.retryAt === null) {
        this.publish(panel, { type: "panel-error", panelId: panel.id, ...described });
      } else {
        log.warn("poller.panel_backing_off", {
          dashboardId: this.dashboardId,
          panelId: panel.id,
          failures: health.failures,
          retryAt: new Date(health.retryAt).toISOString(),
        });
        this.publish(panel, {
          type: "panel-degraded",
          panelId: panel.id,
          ...described,
          failures: health.failures,
          retryAt: health.retryAt,
        });
      }
    } finally {
      this.executing.delete(panel.id);
    }
  }

  /**
   * A viewer's "retry now" on a panel that is backing off (#44): run it at
   * once instead of at its `retryAt`. Returns whether it was started.
   *
   * Refused for a panel that is healthy or still under the threshold (the next
   * tick runs it anyway), for one already executing, and within
   * `MIN_REFRESH_INTERVAL_MS` of its last attempt, so the button cannot run a
   * failing statement faster than a dashboard's own refresh could. A failed
   * retry counts like any other failure and lengthens the wait.
   */
  retryPanel(panelId: string): boolean {
    if (!this.running) return false;
    // A query-less panel (#202) has nothing to retry.
    const panel = this.spec.panels.filter(hasQuery).find((p) => p.id === panelId);
    if (!panel || this.executing.has(panelId)) return false;
    if (!canRetryNow(this.health.get(panelId), Date.now(), config.minRefreshIntervalMs)) {
      return false;
    }
    let window: TimeWindow;
    try {
      window = resolveTimeRange(this.spec.timeRange);
    } catch {
      // The tick reports a range that will not resolve; nothing to retry here.
      return false;
    }
    // A panel with a window of its own resolves it in `runPanel`.
    this.runPanel(panel, window).catch((err) => {
      log.error("poller.retry_crashed", { dashboardId: this.dashboardId, panelId, err });
    });
    return true;
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
      // A timer that fired has reached the time it was set for, whatever the
      // clock reads, so the cadence it was set for is due.
      const now = Math.max(Date.now(), this.scheduledFor);
      const due = this.dueCadences(now);
      // Due from now until the cycle completes, so a failed cycle is retried
      // on the cadence's own interval rather than at once.
      for (const c of due) this.nextDue.set(c, now + c);
      const window = resolveTimeRange(this.spec.timeRange);
      // Only the panels whose cadence is due (#114). A panel backing off
      // (#44) sits out until its `retryAt`, and keeps the `panel-degraded` it
      // last published, which is what a joiner is sent. One a viewer is
      // retrying is already running.
      // A text panel (#202) has no query and is never executed.
      await Promise.all(
        this.spec.panels
          .filter(hasQuery)
          .filter((p) => due.has(this.intervalOf(p)))
          .filter((p) => isDue(this.health.get(p.id), now) && !this.executing.has(p.id))
          .map((p) => this.runPanel(p, window)),
      );
      // Each interval runs from the end of its cycle, as the dashboard's
      // always did, so a slow cycle is never followed by one at once.
      const finishedAt = Date.now();
      for (const c of due) this.nextDue.set(c, finishedAt + c);
      // Every panel is executed and broadcast by this point, so the tick's cost
      // is the whole cycle — not one query — which is what a refresh interval
      // has to accommodate.
      observePollerTick(this.dashboardId, (performance.now() - startedAt) / 1000);
      // Only on a completed cycle: `tick` is what the viewer's freshness
      // readout and staleness watchdog run on, so a failed cycle must not
      // refresh it.
      this.dashboardError = null;
      this.lastTick = {
        type: "tick",
        at: Date.now(),
        window: { from: window.from.getTime(), to: window.to.getTime() },
      };
      this.broadcast(this.lastTick);
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
 *
 * `scope` is the subscriber's row-filter claim values (#31, `rowScopeFor`),
 * and is part of the key: subscribers share a poller only when they would see
 * the same rows. A dashboard with no row-filtered source has an empty scope,
 * and every viewer shares one poller as before.
 *
 * `variables` is the subscriber's checked variable values (#67), and is part
 * of the key too: two viewers with different selections are different
 * statements, and share nothing.
 */
export function getPoller(
  dashboardId: string,
  version: number,
  workspaceId: string,
  spec: Dashboard,
  scope: RowScope,
  executor: PanelExecutor = defaultPanelExecutor,
  variables: VariableValues = {},
): DashboardPoller {
  const scopeKey = Object.entries(scope).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const key = JSON.stringify([
    dashboardId,
    spec.timeRange.from,
    spec.timeRange.to,
    scopeKey,
    valuesKey(variables),
  ]);
  const existing = registry.get(key);
  if (existing?.isStalled) {
    // Sharing it would hand this subscriber a poller that never ticks again.
    log.warn("poller.stalled_replaced", { dashboardId, version: existing.version });
    existing.stop();
  } else if (existing) {
    if (existing.version >= version) return existing;
    existing.stop();
  }
  const poller = new DashboardPoller(
    dashboardId,
    version,
    workspaceId,
    spec,
    scope,
    executor,
    configuredBackoff(),
    variables,
  );
  registry.set(key, poller);
  return poller;
}

/**
 * Retry a panel that is backing off, on every poller showing the dashboard
 * (#44). Returns how many started. Every poller, not only the caller's: one
 * viewer's retry runs the panel for each set of rows it is shown to, and each
 * result goes only to that poller's own subscribers.
 */
export function retryPanel(dashboardId: string, panelId: string): number {
  let started = 0;
  for (const poller of registry.values()) {
    if (poller.dashboardId === dashboardId && poller.retryPanel(panelId)) started++;
  }
  return started;
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
