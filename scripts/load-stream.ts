/**
 * Open many viewers of one dashboard's live stream and report what it costs
 * (#489). A manual tool, not a CI job: run it against `npm run dev:demo` (or
 * any instance in `AUTH_MODE=demo`, where a session is one request away).
 *
 *   npx tsx scripts/load-stream.ts [--base http://localhost:3000]
 *     [--viewers 100] [--slow 5] [--seconds 60] [--dashboard "Demo fleet"]
 *
 * `--slow` of the viewers never read their stream, the way a stalled client
 * or a buffering proxy does: with backpressure they are dropped after
 * `SSE_SLOW_TICKS` cycles, and the others are not. Prints, per cycle, the
 * bytes the readers received and how many streams are open, then a summary.
 */

interface Args {
  base: string;
  viewers: number;
  slow: number;
  seconds: number;
  dashboard?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    base: "http://localhost:3000",
    viewers: 100,
    slow: 5,
    seconds: 60,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--base") args.base = value;
    else if (flag === "--viewers") args.viewers = Number(value);
    else if (flag === "--slow") args.slow = Number(value);
    else if (flag === "--seconds") args.seconds = Number(value);
    else if (flag === "--dashboard") args.dashboard = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return args;
}

/** A demo visitor's session: `/api/auth/login` mints one in demo mode. */
async function session(base: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, { redirect: "manual" });
  const cookies = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (cookies.length === 0) {
    throw new Error(`no session from ${base}/api/auth/login: is AUTH_MODE=demo set?`);
  }
  return cookies.join("; ");
}

async function dashboardId(
  base: string,
  cookie: string,
  title?: string,
): Promise<string> {
  const res = await fetch(`${base}/api/dashboards`, { headers: { cookie } });
  if (!res.ok) throw new Error(`listing dashboards: ${res.status}`);
  const body = (await res.json()) as {
    dashboards?: Array<{ id: string; title: string }>;
  };
  const list = body.dashboards ?? [];
  const found = title ? list.find((d) => d.title === title) : list[0];
  if (!found) throw new Error(`no dashboard${title ? ` titled "${title}"` : ""}`);
  return found.id;
}

interface Viewer {
  bytes: number;
  ticks: number;
  dropped: boolean;
  open: boolean;
}

async function watch(
  url: string,
  cookie: string,
  stall: Promise<void> | null,
  viewer: Viewer,
  stop: AbortSignal,
) {
  const res = await fetch(url, {
    headers: { cookie, accept: "text/event-stream" },
    signal: stop,
  });
  if (!res.ok || !res.body) throw new Error(`stream: ${res.status}`);
  viewer.open = true;
  // A slow viewer holds the connection and reads nothing until the end of
  // the run, then reads what was left for it, to see whether it was dropped.
  if (stall) await stall;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      viewer.bytes += value.byteLength;
      const text = decoder.decode(value, { stream: true });
      viewer.ticks += text.split('"type":"tick"').length - 1;
      if (text.includes("event: drop")) viewer.dropped = true;
    }
  } catch {
    /* aborted */
  }
  viewer.open = false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cookie = await session(args.base);
  const id = await dashboardId(args.base, cookie, args.dashboard);
  const url = `${args.base}/api/dashboards/${id}/stream`;
  const stop = new AbortController();
  const viewers: Viewer[] = Array.from({ length: args.viewers }, () => ({
    bytes: 0,
    ticks: 0,
    dropped: false,
    open: false,
  }));
  let unstall = () => {};
  const stall = new Promise<void>((resolve) => {
    unstall = resolve;
  });
  const runs = viewers.map((v, i) =>
    watch(url, cookie, i < args.slow ? stall : null, v, stop.signal).catch(
      (err: unknown) => {
        process.stderr.write(`viewer ${i}: ${String(err)}\n`);
      },
    ),
  );

  const readers = viewers.slice(args.slow);
  let lastTicks = 0;
  let lastBytes = 0;
  const started = Date.now();
  process.stdout.write(`${args.viewers} viewers (${args.slow} not reading) on ${url}\n`);
  process.stdout.write("seconds\tcycles\treader bytes this cycle\topen streams\n");
  const timer = setInterval(() => {
    const ticks = Math.min(...readers.map((v) => v.ticks));
    if (ticks > lastTicks) {
      const bytes = readers.reduce((n, v) => n + v.bytes, 0);
      const open = viewers.filter((v) => v.open).length;
      const seconds = ((Date.now() - started) / 1000).toFixed(0);
      process.stdout.write(`${seconds}\t${ticks}\t${bytes - lastBytes}\t${open}\n`);
      lastTicks = ticks;
      lastBytes = bytes;
    }
  }, 250);

  await new Promise((r) => setTimeout(r, args.seconds * 1000));
  clearInterval(timer);
  // Let the stalled viewers read their backlog: a dropped one ends with the
  // drop frame and a closed stream.
  unstall();
  await new Promise((r) => setTimeout(r, 3_000));
  const open = viewers.filter((v) => v.open).length;
  stop.abort();
  await Promise.all(runs);
  const stalled = viewers.slice(0, args.slow);

  const bytes = readers.reduce((n, v) => n + v.bytes, 0);
  const cycles = Math.min(...readers.map((v) => v.ticks));
  process.stdout.write(
    [
      "",
      `cycles seen by every reader: ${cycles}`,
      `bytes to readers: ${bytes} (${cycles > 0 ? Math.round(bytes / cycles / readers.length) : 0} per reader per cycle)`,
      `readers dropped: ${readers.filter((v) => v.dropped).length} of ${readers.length}`,
      `stalled viewers dropped: ${stalled.filter((v) => v.dropped).length} of ${stalled.length}`,
      `streams still open at the end: ${open} of ${viewers.length}`,
      "",
    ].join("\n"),
  );
}

main().catch((err: unknown) => {
  process.stderr.write(`${String(err)}\n`);
  process.exit(1);
});
