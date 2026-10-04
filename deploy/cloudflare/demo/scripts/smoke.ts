/**
 * End-to-end check of a deployed demo (#254), run by .github/workflows/demo.yml
 * after every deploy and runnable by hand:
 *
 *   DEMO_URL=https://holotable-demo.vibeproject.workers.dev npm run smoke
 *
 * Waits through the cold start, enters the demo the way a browser does, finds
 * a seeded dashboard and runs one of its panels through POST /api/query, and
 * fails unless real rows come back. Plain Node 22, no dependencies.
 */

const base = (process.env.DEMO_URL ?? "http://localhost:8799").replace(/\/$/, "");
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 360_000);
const deadline = Date.now() + timeoutMs;

function fail(message: string): never {
  console.error(`smoke: FAILED: ${message}`);
  process.exit(1);
}

async function waitForReady(): Promise<void> {
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/ready`, {
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 3_000));
  }
  fail(`${base}/api/ready did not answer 200 within ${timeoutMs} ms (last: ${last})`);
}

async function enter(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login?next=/`, { redirect: "manual" });
  const cookie = res.headers
    .getSetCookie()
    .find((c) => c.startsWith("holotable_session="));
  if (res.status !== 302 || !cookie) {
    fail(`demo sign-in answered ${res.status} without a session cookie`);
  }
  return cookie.split(";")[0];
}

async function json<T>(path: string, cookie: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), cookie, "content-type": "application/json" },
  });
  if (!res.ok)
    fail(`${init.method ?? "GET"} ${path} answered ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

interface Panel {
  title: string;
  query: { sourceId: string; sql: string; timeField?: string };
}

const started = Date.now();
await waitForReady();
console.log(`smoke: ${base} ready after ${Math.round((Date.now() - started) / 1000)} s`);

const cookie = await enter();
const list = await json<{ dashboards: { id: string; title: string }[] }>(
  "/api/dashboards",
  cookie,
);
const seeded = list.dashboards.find((d) => d.title === "Demo service health");
if (!seeded) fail(`no "Demo service health" dashboard among ${list.dashboards.length}`);

const { dashboard } = await json<{ dashboard: { spec: { panels: Panel[] } } }>(
  `/api/dashboards/${seeded.id}`,
  cookie,
);
const panel = dashboard.spec.panels.find((p) => p.query.timeField);
if (!panel) fail("the seeded dashboard has no time-series panel");

// The seeder runs beside the server rather than before it, so /api/ready can
// answer before the backfill's first rows land. Poll until they do.
let rows = 0;
while (true) {
  const result = await json<{ rows: unknown[] }>("/api/query", cookie, {
    method: "POST",
    body: JSON.stringify({
      sourceId: panel.query.sourceId,
      sql: panel.query.sql,
      timeField: panel.query.timeField,
      timeRange: { from: "now-1h", to: "now" },
    }),
  });
  rows = result.rows.length;
  if (rows > 0) break;
  if (Date.now() >= deadline) fail(`"${panel.title}" returned no rows`);
  await new Promise((r) => setTimeout(r, 3_000));
}
console.log(`smoke: OK, "${panel.title}" returned ${rows} rows`);

export {};
