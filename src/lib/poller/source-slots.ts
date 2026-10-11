import { config } from "@/lib/config";

/**
 * How many poller executions may run against one source at once (#487).
 *
 * One below the source's pool size, so an interactive query (Chat, a
 * preview, `/api/query`) always finds a connection however busy the
 * dashboards are. Interactive paths are not gated here; only the poller is.
 */
export function pollerSlotsPerSource(): number {
  return Math.max(1, config.maxPoolPerSource - 1);
}

interface Waiter {
  grant: (release: () => void) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Gate {
  inFlight: number;
  queue: Waiter[];
}

/**
 * A counting semaphore per source id. `acquire` resolves with a release
 * function once a slot is free, or `null` when none came free within
 * `waitMs`: the caller skips this execution rather than failing it, and the
 * next tick tries again.
 *
 * The id is only a key: nothing here reads the source, so it cannot be used
 * to learn anything about one. Authorization stays in the executor.
 */
export class SourceSlots {
  private gates = new Map<string, Gate>();

  constructor(private readonly capacity: () => number = pollerSlotsPerSource) {}

  acquire(sourceId: string, waitMs: number): Promise<(() => void) | null> {
    const gate = this.gates.get(sourceId) ?? { inFlight: 0, queue: [] };
    this.gates.set(sourceId, gate);
    if (gate.inFlight < this.capacity()) {
      gate.inFlight++;
      return Promise.resolve(this.releaser(sourceId, gate));
    }
    return new Promise((resolve) => {
      const waiter: Waiter = {
        grant: (release) => resolve(release),
        timer: setTimeout(() => {
          gate.queue = gate.queue.filter((w) => w !== waiter);
          this.forget(sourceId, gate);
          resolve(null);
        }, waitMs),
      };
      gate.queue.push(waiter);
    });
  }

  /** Executions holding a slot on `sourceId` right now. */
  inFlight(sourceId: string): number {
    return this.gates.get(sourceId)?.inFlight ?? 0;
  }

  private releaser(sourceId: string, gate: Gate): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = gate.queue.shift();
      if (next) {
        // The slot passes straight to the next waiter: in flight is unchanged.
        clearTimeout(next.timer);
        next.grant(this.releaser(sourceId, gate));
        return;
      }
      gate.inFlight--;
      this.forget(sourceId, gate);
    };
  }

  /** Drop an idle gate, so a source nobody polls holds no entry. */
  private forget(sourceId: string, gate: Gate): void {
    if (gate.inFlight === 0 && gate.queue.length === 0) this.gates.delete(sourceId);
  }
}

const CACHE_KEY = Symbol.for("holotable.pollerSourceSlots");
type Cache = { [CACHE_KEY]?: SourceSlots };

/**
 * The process's one set of slots. On `globalThis` for the reason the source
 * pools are: two bundled copies would mean twice the cap.
 */
export function pollerSourceSlots(): SourceSlots {
  const cache = globalThis as Cache;
  cache[CACHE_KEY] ??= new SourceSlots();
  return cache[CACHE_KEY];
}
