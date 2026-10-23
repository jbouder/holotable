/**
 * The demo Worker's decisions, as pure functions over a Request, so they can
 * be tested with plain Node and no Workers runtime (test/policy.test.ts).
 */

/** Which per-IP limit a request counts against. */
export type Bucket = "write" | "read";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `write` is any non-GET call to the app's API: generation, queries, edits,
 * chat, sign-in and sign-out. Those cost CPU, database time or model tokens.
 * Everything else (pages, static assets, the live SSE stream, reads) is
 * `read`, which only has to stop a flood.
 */
export function bucketFor(request: Request): Bucket {
  const { pathname } = new URL(request.url);
  if (!SAFE_METHODS.has(request.method) && pathname.startsWith("/api/")) return "write";
  return "read";
}

/**
 * Who a limit is keyed on. `CF-Connecting-IP` is set by Cloudflare's edge on
 * every request to a Worker and cannot be supplied by the client, unlike
 * `X-Forwarded-For`.
 */
export function clientKey(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "unknown";
}

/** A browser navigation, as opposed to fetch, XHR, SSE or an asset. */
export function wantsDocument(request: Request): boolean {
  if (request.method !== "GET") return false;
  const dest = request.headers.get("sec-fetch-dest");
  if (dest) return dest === "document";
  return (request.headers.get("accept") ?? "").includes("text/html");
}

/**
 * The request as the container should see it. The containers library proxies
 * over plain HTTP to the instance, so the app would otherwise build its demo
 * sign-in redirect for `http://`; it reads the visitor's real scheme and host
 * from these headers (src/proxy.ts). Client-sent copies are overwritten.
 */
export function forContainer(request: Request): Request {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("x-forwarded-proto", url.protocol.replace(/:$/, ""));
  headers.set("x-forwarded-host", url.host);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  else headers.delete("x-forwarded-for");
  return new Request(request, { headers });
}

/** The pages' headers. The one script a page runs is let in by its nonce. */
function pageHeaders(nonce: string): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  };
}

/**
 * The app's default palette (src/app/globals.css): dark, and light under
 * `data-theme="light"`. These pages are served before the app is up, so they
 * carry their own copy; the CSP allows no fonts, so the type is the system's.
 */
const TOKENS = `
  :root { color-scheme: dark;
    --background: oklch(0.15 0.012 260); --surface: oklch(0.195 0.012 260);
    --surface-2: oklch(0.24 0.012 260); --border: oklch(0.33 0.012 260);
    --foreground: oklch(0.95 0.008 260); --muted: oklch(0.72 0.015 260);
    --primary: oklch(0.72 0.13 250); --success: oklch(0.8 0.12 160);
    --chart-1: oklch(0.68 0.13 250); --chart-2: oklch(0.72 0.12 160);
    --chart-3: oklch(0.8 0.13 80); --chart-4: oklch(0.72 0.15 25); }
  :root[data-theme="light"] { color-scheme: light;
    --background: oklch(0.975 0.004 260); --surface: oklch(1 0 0);
    --surface-2: oklch(0.955 0.006 260); --border: oklch(0.86 0.01 260);
    --foreground: oklch(0.22 0.02 260); --muted: oklch(0.5 0.02 260);
    --primary: oklch(0.5 0.17 255); --success: oklch(0.44 0.1 160);
    --chart-1: oklch(0.52 0.15 250); --chart-2: oklch(0.56 0.12 160);
    --chart-3: oklch(0.62 0.15 70); --chart-4: oklch(0.55 0.17 25); }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
         font: 16px/1.5 ui-sans-serif, system-ui, sans-serif;
         background: var(--background); color: var(--foreground); }
  main { width: 100%; max-width: 32rem; padding: 2rem 1rem; box-sizing: border-box; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { margin: .5rem 0; color: var(--muted); }`;

/**
 * The scheme and motion the app would use, before first paint: these pages
 * share the app's origin, so they read what it stored (src/lib/theme.ts,
 * src/lib/motion.ts, resolved like src/lib/bootstrap.ts) and fall back to its
 * defaults, dark and the browser's motion setting. "system" follows the
 * browser. Constant text, nothing from the request.
 */
const PREFERENCES_SCRIPT = `(function(){var d=document.documentElement;try{var p=localStorage.getItem("theme");if(p!=="dark"&&p!=="light"&&p!=="system")p="dark";d.dataset.theme=p==="system"?(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p}catch(e){}try{var m=localStorage.getItem("motion");if(m!=="system"&&m!=="reduce"&&m!=="allow")m="system";d.dataset.motion=m==="system"?(matchMedia("(prefers-reduced-motion: reduce)").matches?"reduce":"allow"):m}catch(e){}})()`;

function page(
  title: string,
  body: string,
  init: { status: number; headers: Record<string, string> },
  style = "",
): Response {
  const nonce = crypto.randomUUID();
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<script nonce="${nonce}">${PREFERENCES_SCRIPT}</script>
<title>${title}</title>
<style>${TOKENS}${style}</style>
</head>
<body><main>${body}</main></body>
</html>`,
    { status: init.status, headers: { ...pageHeaders(nonce), ...init.headers } },
  );
}

/** What a boot does, and roughly when each step starts, as a share of the boot. */
const BOOT_STAGES: ReadonlyArray<readonly [label: string, at: number]> = [
  ["Provisioning the container", 0],
  ["Starting TimescaleDB", 0.12],
  ["Running migrations", 0.35],
  ["Backfilling six hours of demo history", 0.48],
  ["Starting the server", 0.85],
];

/** The bar never reaches the end on its own: only the app answering does. */
const MAX_SHOWN = 0.95;

/**
 * The starting page's look. It reloads every few seconds, so every animation
 * is offset by `--t`, the seconds since the boot began: a reload picks each
 * one up where the last page left it instead of starting over. Only opacity
 * and transform move, and a visitor who asks for reduced motion (in the app or,
 * failing that, the browser) gets still frames.
 */
const STARTING_STYLE = `
  main { max-width: 30rem; }
  .brand { display: flex; align-items: center; gap: .5rem; margin-bottom: 1.5rem;
           font-weight: 600; letter-spacing: .02em; }
  .brand svg { color: var(--primary); }
  .brand span { color: var(--muted); font-weight: 400; }
  .board { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 3.5rem 2rem 3.5rem;
           gap: .5rem; margin-bottom: 1.75rem; }
  .tile { background: var(--surface); border: 1px solid var(--border); overflow: hidden;
          position: relative; animation: rise .5s cubic-bezier(.2,0,0,1) backwards;
          animation-delay: calc(var(--i) * 90ms - var(--t)); }
  .a { grid-row: 1 / 3; } .b { grid-row: 1; } .c { grid-row: 2 / 4; } .d { grid-row: 3; }
  .tile svg { position: absolute; inset: 0; width: 100%; height: 100%; }
  .line { fill: none; stroke: var(--chart-1); stroke-width: 2; stroke-linecap: round;
          stroke-dasharray: 100; animation: draw 3s ease-in-out infinite;
          animation-delay: calc(0s - var(--t)); }
  .area { fill: var(--chart-1); opacity: .15; animation: breathe 3s ease-in-out infinite;
          animation-delay: calc(0s - var(--t)); }
  .bars { position: absolute; inset: .75rem .75rem .5rem; display: flex; align-items: flex-end; gap: .375rem; }
  .bars i { flex: 1; height: 100%; background: var(--chart-2); transform-origin: bottom;
            animation: bar 2.4s ease-in-out infinite alternate;
            animation-delay: calc(var(--d) - var(--t)); }
  .stat { position: absolute; inset: 0 .75rem; display: flex; align-items: center; gap: .5rem; }
  .stat b { width: 2.5rem; height: .625rem; background: var(--chart-3); opacity: .8; }
  .stat i { flex: 1; height: .375rem; background: var(--surface-2); }
  .pulse { position: absolute; inset: 0 .75rem; display: flex; align-items: center; gap: .375rem; }
  .pulse i { width: .5rem; height: .5rem; border-radius: 50%; background: var(--chart-4);
             animation: blink 1.2s ease-in-out infinite;
             animation-delay: calc(var(--d) - var(--t)); }
  .track { height: .375rem; background: var(--surface-2); margin: 1.25rem 0 .5rem; overflow: hidden; }
  .fill { height: 100%; background: var(--primary); transform-origin: left;
          transform: scaleX(var(--from)); animation: fill var(--step) linear forwards; }
  .meta { display: flex; justify-content: space-between; font-size: .875rem; color: var(--muted);
          font-variant-numeric: tabular-nums; }
  ol { list-style: none; padding: 0; margin: 1.25rem 0 0; display: grid; gap: .5rem; font-size: .9375rem; }
  li { display: flex; align-items: center; gap: .625rem; color: var(--muted); }
  li[data-state="active"] { color: var(--foreground); }
  li svg { flex: none; }
  li[data-state="done"] svg { color: var(--success); }
  li[data-state="active"] svg { color: var(--primary); animation: spin 1s linear infinite;
                                animation-delay: calc(0s - var(--t)); }
  .note { font-size: .875rem; }
  @keyframes rise { from { opacity: 0; transform: translateY(.5rem); } }
  @keyframes draw { 0% { stroke-dashoffset: 100; } 55%, 100% { stroke-dashoffset: 0; } }
  @keyframes breathe { 0%, 100% { opacity: .08; } 60% { opacity: .2; } }
  @keyframes bar { from { transform: scaleY(.25); } to { transform: scaleY(1); } }
  @keyframes blink { 0%, 100% { opacity: .25; transform: scale(.8); } 50% { opacity: 1; transform: scale(1); } }
  @keyframes fill { to { transform: scaleX(var(--to)); } }
  @keyframes spin { to { transform: rotate(1turn); } }
  :root[data-motion="reduce"] *, :root[data-motion="reduce"] *::before, :root[data-motion="reduce"] *::after {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
  @media (prefers-reduced-motion: reduce) { :root:not([data-motion]) * {
    animation-duration: .01ms !important; animation-iteration-count: 1 !important; } }`;

/** The Holotable mark (`src/components/ui/logo.tsx`), inline: the CSP allows no external image. */
const LOGO = `<svg width="32" height="32" viewBox="0 0 16 16" shape-rendering="crispEdges" aria-hidden="true"><path fill="currentColor" d="M7 4h2v1H7zM5 5h6v1H5zM3 6h4v1H3zM9 6h4v1H9zM1 7h4v1H1zM11 7h4v1h-4zM3 8h4v1H3zM9 8h4v1H9zM1 9h2v1H1zM5 9h6v1H5zM13 9h2v1h-2zM3 10h2v1H3zM7 10h2v1H7zM11 10h2v1h-2zM5 11h2v1H5zM9 11h2v1H9zM7 12h2v1H7z"/></svg>`;
const DONE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="7"/><path d="m5 8 2 2 4-4"/></svg>`;
const ACTIVE = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 1a7 7 0 1 1-7 7" /></svg>`;
const PENDING = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="8" cy="8" r="6.5" stroke-dasharray="2 2.5"/></svg>`;

/** A dashboard drawing itself. Decoration only. */
const BOARD = `<div class="board" aria-hidden="true">
<div class="tile a" style="--i:0"><svg viewBox="0 0 100 60" preserveAspectRatio="none"><path class="area" d="M0 48 L14 40 L28 44 L42 26 L56 32 L70 16 L84 22 L100 8 L100 60 L0 60 Z"/><path class="line" pathLength="100" vector-effect="non-scaling-stroke" d="M0 48 L14 40 L28 44 L42 26 L56 32 L70 16 L84 22 L100 8"/></svg></div>
<div class="tile b" style="--i:1"><div class="stat"><b></b><i></i></div></div>
<div class="tile c" style="--i:2"><div class="bars"><i style="--d:0s"></i><i style="--d:-.6s"></i><i style="--d:-1.4s"></i><i style="--d:-.3s"></i><i style="--d:-1.9s"></i><i style="--d:-1s"></i></div></div>
<div class="tile d" style="--i:3"><div class="pulse"><i style="--d:0s"></i><i style="--d:.2s"></i><i style="--d:.4s"></i></div></div>
</div>`;

/** How long the starting page waits before it asks again, in seconds. */
const RETRY_SECONDS = 3;

/**
 * What a visitor sees while the container boots: a fresh database, migrations
 * and six hours of backfilled history. It refreshes itself; once the container
 * answers, the same URL serves the app. `elapsed` is how long this boot has
 * been running, so each refresh carries the progress on rather than restarting.
 */
export function startingResponse(
  request: Request,
  seconds: number,
  elapsed = 0,
): Response {
  const retry = String(RETRY_SECONDS);
  if (!wantsDocument(request)) {
    return Response.json(
      { error: "The demo is starting. Try again in a few seconds.", kind: "unavailable" },
      { status: 503, headers: { "retry-after": retry, "cache-control": "no-store" } },
    );
  }
  const t = Math.max(0, Math.floor(elapsed));
  const share = (s: number) => Math.min(MAX_SHOWN, s / seconds);
  const from = share(t);
  const to = share(t + RETRY_SECONDS);
  const now = t / seconds;
  let current = 0;
  BOOT_STAGES.forEach(([, at], i) => {
    if (at <= now) current = i;
  });
  const stages = BOOT_STAGES.map(([label], i) => {
    const state = i < current ? "done" : i === current ? "active" : "pending";
    const icon = state === "done" ? DONE : state === "active" ? ACTIVE : PENDING;
    return `<li data-state="${state}">${icon}${label}</li>`;
  }).join("");
  const percent = Math.round(from * 100);
  const overdue = t > seconds;
  return page(
    "Starting the Holotable demo",
    `<div class="brand">${LOGO}Holotable <span>demo</span></div>
${BOARD}
<h1>Spinning up your demo</h1>
<p>The demo was asleep, so it is waking up with a fresh database, its migrations and six hours of demo history. It takes about ${seconds} seconds.</p>
<div class="track" role="progressbar" aria-label="Starting the demo" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><div class="fill" style="--from:${from};--to:${to};--step:${RETRY_SECONDS}s"></div></div>
<div class="meta"><span>${t}s elapsed</span><span>This page refreshes on its own</span></div>
<ol>${stages}</ol>
${overdue ? `<p class="note">Taking longer than usual. The first start after a deploy pulls a fresh image, which can add a minute or two.</p>` : ""}`,
    { status: 503, headers: { refresh: retry, "retry-after": retry } },
    `:root { --t: ${t}s; }${STARTING_STYLE}`,
  );
}

/** What a client over its per-IP limit gets. */
export function limitedResponse(request: Request, bucket: Bucket): Response {
  const retry = bucket === "write" ? "60" : "10";
  if (!wantsDocument(request)) {
    return Response.json(
      {
        error:
          "Too many requests from your address to the demo. Wait a minute and try again.",
        kind: "rate_limited",
      },
      { status: 429, headers: { "retry-after": retry, "cache-control": "no-store" } },
    );
  }
  return page(
    "Slow down",
    `<h1>Too many requests</h1>
<p>Your address has sent more requests than the public demo allows. Wait a minute and reload.</p>`,
    { status: 429, headers: { "retry-after": retry } },
  );
}

/**
 * The demo's model limits, tighter than the app's defaults because every
 * visitor shares one workspace and a fresh session resets the per-person
 * bucket. Strings, because container environment variables are strings.
 */
export function demoLimits(vars: {
  LLM_RATE_PER_MINUTE?: string;
  LLM_DAILY_TOKEN_BUDGET?: string;
}): { LLM_RATE_PER_MINUTE: string; LLM_DAILY_TOKEN_BUDGET: string } {
  const positive = (v: string | undefined, fallback: string) =>
    v && /^[1-9]\d*$/.test(v) ? v : fallback;
  return {
    LLM_RATE_PER_MINUTE: positive(vars.LLM_RATE_PER_MINUTE, "5"),
    LLM_DAILY_TOKEN_BUDGET: positive(vars.LLM_DAILY_TOKEN_BUDGET, "300000"),
  };
}
