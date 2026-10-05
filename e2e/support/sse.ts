import type { Page } from "@playwright/test";

/**
 * Count what actually arrives over the dashboard's EventSource (#88), so a
 * streaming assertion is about frames on the wire rather than about a page
 * that rendered. Installed before the page's own scripts run; the app's
 * `EventSource` is the real one, observed, not replaced.
 */

export interface SseCounts {
  /** Streams opened so far. */
  opened: number;
  /** Streams the page has closed itself (pause, navigation). */
  closed: number;
  /** `panel` frames: a panel's rows, appended or replaced. */
  panels: number;
  /** Rows carried by those frames, in total. */
  rows: number;
  /** `tick` frames: one per completed poll cycle. */
  ticks: number;
}

export async function observeSse(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts = { opened: 0, closed: 0, panels: 0, rows: 0, ticks: 0 };
    (window as unknown as { __sse: typeof counts }).__sse = counts;
    const Native = window.EventSource;
    class Observed extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        counts.opened++;
        this.addEventListener("message", (e) => {
          try {
            const frame = JSON.parse((e as MessageEvent<string>).data);
            if (frame?.type === "panel") {
              counts.panels++;
              counts.rows += Array.isArray(frame.rows) ? frame.rows.length : 0;
            }
            if (frame?.type === "tick") counts.ticks++;
          } catch {
            // A frame the app would also ignore.
          }
        });
      }
      close() {
        counts.closed++;
        super.close();
      }
    }
    window.EventSource = Observed;
  });
}

export function sseCounts(page: Page): Promise<SseCounts> {
  return page.evaluate(() => (window as unknown as { __sse: SseCounts }).__sse);
}
