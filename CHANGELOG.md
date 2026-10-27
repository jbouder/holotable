# Changelog

What changed for people who run or use Holotable, by release. The GitHub
release page carries the matching section below, followed by the list of
pull requests merged since the previous tag. `CONTRIBUTING.md` ("Releasing")
says how a section gets here.

## 0.3.0 — 2026-10-27

Two new source kinds and three ways to get your own files in: Loki (M19,
#559), DuckDB (M20, #569) and uploads from the browser (#595–#607), with a
local mode for one person's machine. Then a round of panel kinds (graphs,
directed graphs, force graphs, Sankey) and a styling pass that gives every
chart one style, a new default look and a logo of Holotable's own.

### Added

- **Loki sources.** A third source kind, `loki`: a Loki-compatible endpoint
  whose panels carry LogQL, the third query language beside SQL and PromQL
  (`query.logql` in the IR). Generation, chat, the MCP tools and the
  `/holotable` skill write it; the panel editor has a LogQL editor with
  highlighting, completion over the source's labels and the guard's lint;
  a label-values variable picks one value from streams; and a log line's
  labels feed drilldown links. Every expression goes through a LogQL guard
  of its own (parse tree, label allowlist, allowlisted stages and
  functions, a range cap, a tenant matcher spliced and re-parsed, variables
  bound only as matcher or line-filter values), fuzzed like the other two.
  Adding one is the same three verbs as Prometheus: a form with label
  discovery, a test report and a refresh review. `LOKI_MAX_ENTRIES` (1,000)
  and `LOKI_MAX_SERIES` (100) bound a result; a log query that came back
  full says so with a "Newest N lines" badge. Compose gains a `logs`
  profile (Loki and Alloy) that seeds a Holotable logs dashboard over the
  app's own lines, and every guard refusal is now also a `guard.refused`
  log line.
- **DuckDB sources.** A fourth source kind, `duckdb`: a directory of
  Parquet, CSV and JSON (`.json`, `.jsonl`, `.ndjson`) files, or a
  `.duckdb` file, under `DUCKDB_SOURCES_DIR`, queried in process through
  the same SQL guard and planner as TimescaleDB. The engine is locked (no
  file, network or extension access past the source's own files) and the
  guard learned DuckDB's escapes: its file, network and introspection
  functions are refused, and a table function in `FROM` is refused unless
  allowlisted. A path picker lists what the root holds, Discover finds the
  tables, and the test report shows the lock verdict and the engine. The
  model is told DuckDB's dialect; the stub and the skill know it. With
  `SEED_DEMO_FILES=true` the seeder writes a files demo and a Demo files
  dashboard. `DUCKDB_MEMORY_LIMIT` and `DUCKDB_THREADS` bound the engine.
  The runtime image carries the DuckDB binding, so the kind works under
  compose and Helm, not only the quick-start image.
- **Upload your own files.** **Add source → Upload files** makes a DuckDB
  source from files chosen or dropped in the browser, with no access to the
  server's file system: CSV, JSON and Excel workbooks (`.xlsx`, `.xlsm`,
  one table per sheet, converted on the server with cells typed and dates
  in UTC). Each file shows its own progress; a refused file is named with
  the reason. An upload source takes more files later (**Add files** beside
  Refresh, with the refresh review offering them as new tables), and
  deleting the source removes its directory. Uploads are held to their
  workspace by the path guard, bounded by `DUCKDB_UPLOAD_MAX_BYTES`
  (50 MiB per file) and `DUCKDB_UPLOAD_MAX_FILES` (20), rate limited and
  audited as `source.upload`; an upload abandoned in the form is swept
  after an hour. Three samples (household expenses, workouts, home energy)
  are one click away in the form.
- **Starters for files.** A new source whose table looks like spending, an
  activity log or daily measurements is recognized by its columns, and New
  dashboard leads with a ready dashboard for it ("Start from"), applied
  with no model call. The data sources page offers the same right after
  Create source.
- **Local mode.** `AUTH_MODE=local` signs everyone who can reach the server
  in as its one owner, with `LOCAL_GROUPS` (default a source admin of the
  `local` workspace), so one person on their own machine can add sources
  and upload files, which demo mode's editor cap forbids. It is fenced like
  demo mode: no `OIDC_*`, a banner that says what it means, and nothing in
  verification changed. The quick-start image now runs in it, with a
  writable files volume at `/var/lib/holotable/files`.
- **A model on this machine.** With `LOCAL_MODEL_DETECT` (`auto`: on in
  local mode) Holotable probes `LOCAL_MODEL_ENDPOINTS` (Ollama and LM
  Studio by default) at boot, lists what answers as server models under
  "Detected on this machine" on the Models page, and makes the one found
  the default when the server has no model of its own. **Re-scan** probes
  again (`POST /api/models/detect`, rate limited and audited as
  `model.detect`). The endpoints' hosts join the base-URL allowlist only
  while detection is on.
- **An Anthropic-compatible provider.** A provider kind for endpoints that
  speak Anthropic's Messages API at a URL of their own (OpenCode Zen's
  Claude models, a gateway), with a typed base URL and an optional key,
  beside the OpenAI-compatible kind.
- **Plain PostgreSQL.** A TimescaleDB source records at Test whether the
  server has the extension (migration 026, `sources.catalog_facts`). The
  source list and catalog browser say `PostgreSQL` or `TimescaleDB 2.17.2`,
  and against plain PostgreSQL the model is told to bucket with
  `date_trunc` or `date_bin`, so the first generation against Neon,
  Supabase or RDS no longer fails on `time_bucket`.
- **A graph panel.** `viz: "graph"` draws what points at what as a tree, left
  to right, top to bottom or radial, from one row per edge or from path
  columns, with branches that collapse and expand. Nodes are colored by a
  group column and can be drawn as network icons (server, database, load
  balancer, …). Data that is not a tree is refused with the node named. Demo
  service health gains a service map over a new `metrics.service_calls`
  table, which the seeder creates, backfills and writes once a minute; a
  click on a service (or its store) filters the dashboard to it through a new
  `service` variable. A graph node's datum carries `node`, `parent`, `group`
  and `value` for links.
- **Directed graphs.** `layout: "dag"` on a graph panel draws data where a
  node has several parents or edges form a cycle (a dependency graph, a data
  lineage, a network with redundant links) as layers, left to right or top to
  bottom, with arrows, edges as wide as their value, and a cycle's closing
  edge dashed. A tree whose rows are not a tree now falls back to it with a
  "Not a tree" badge instead of an error. A click on an edge is a datum with
  `source`, `target` and `value`, and a link that finds nothing to read in
  what was clicked is no longer offered. The layout is Holotable's own, not
  `dagre`; the docs' Graph layout page has the measurements. The demo's
  service map gains a `redis` that `api` and `web` share and is drawn as a
  directed graph, and Demo files gains `links.csv` and a network topology
  whose hosts open Demo host detail.
- **Force graphs and Sankey panels.** `layout: "force"` on a graph panel
  draws edges with no useful direction (who talks to whom, what shares a
  network) as a cloud, nodes sized by value, that settles once and keeps its
  place across refreshes; past 60 nodes its labels show on hover. A new
  `viz: "sankey"` draws how much flows where (requests from service to route
  to status, bytes from source to sink) as bands as wide as their volume,
  left to right or top to bottom, from path columns or edge rows. Its `value`
  is required, duplicate flows are summed, rows with no volume are left out
  with a badge saying so, and flows that cycle are refused naming a node on
  the loop. Nodes and bands are datums for links. On Demo service health a
  request-flow Sankey replaces the route-then-status sunburst.
- **A curve option for lines, areas and sparklines.** `options.curve` on a
  `line`, `area` or `stat` is `"straight"` (the default), `"smooth"` or
  `"step"`, which holds each value until the next sample, for counts and
  states that change in jumps; it is the editor's **Line** field under
  Display. Demo host detail gains "Errors logged per minute", drawn in steps,
  which `npm run smoke` and the accessibility scan now check. A line, area or
  bar chart with `decimals` set no longer writes the same tick twice: its
  value axis steps no finer than the decimals show.
- **Graphs drawn as diagrams.** `node: "block"` on a graph panel draws each
  node as a box sized to its name, the name and value inside and an icon
  symbol beside the name, on a tree, a directed graph or a force graph. The
  boxes never overlap; a directed graph's arrows meet their borders. A panel
  too small for them draws markers with a "Drawn as markers" badge. The
  demo's service map and network topology are drawn as blocks.
- **A preference for the dashboard chat button.** Settings → Preferences →
  **Dashboard chat** hides the round chat button on dashboards; the chat
  still opens with C or a panel's "Ask about this panel".

### Changed

- **A new logo.** Holotable has a mark of its own, a table top with what it
  projects rising from it, drawn on a 16-pixel grid with square corners,
  instead of the Dashboards icon (which stays the Dashboards icon). It shows
  in the nav bar, the sign-in page, the favicon (now with `favicon.ico` and
  an Apple touch icon beside `icon.svg`), the docs site, the README and the
  demo's starting page.
- **Treemaps read as groups.** A treemap with levels draws each region as a
  container on the raised surface with its name and total, and shades its
  members by rank from the region's color, so siblings no longer share a
  fill. Each block is labeled at its top left with its name and its value
  (and its share of its parent), and a label that does not fit is left out
  rather than cut. Nodes part by a gutter, the node under the pointer is
  outlined, and a sunburst shades its rings the same way.
- **Lines and areas are straight by default.** A `line` or `area` panel
  without `curve` used to be drawn as a smooth curve, which overshoots peaks,
  dips below zero on a counter that never does and makes a step change look
  gradual; it is now drawn as straight segments between the samples, and a
  large one is no longer drawn differently from a small one. Set
  `"curve": "smooth"` in the panel's options to keep the curve.
- **Four default dashboards.** A default install (`docker compose up` or the
  quick-start image) now seeds exactly four: Demo service health, Demo fleet,
  Demo host detail and Holotable self-monitoring, which between them still
  show every panel kind. The dashboards that show off a source kind are
  opt-in and seeded only when their source is on: the PromQL self-monitoring
  with the new compose `prometheus` profile, Holotable logs with the `logs`
  profile, and Demo files with `SEED_DEMO_FILES=true`. On an upgraded
  install the seeder retires an opt-in dashboard that is off while it still
  owns it, and restores it under the same id when turned back on. Demo
  service health puts the service map and the request flow under its stats
  and drops the server-errors-by-route bar; Demo fleet drops the CPU line and
  the CPU tick plot, which repeated its heatmap.
- **The dashboard list is the home page.** It is served at `/`, and
  `/dashboards` permanently redirects there with its query string; a
  dashboard stays at `/dashboards/<id>`. A start-page preference is applied
  after sign-in instead, so opening the app at its root no longer moves you
  somewhere else.
- **One build behind both images.** The runtime and quick-start images are
  two targets of one `Dockerfile` sharing one `next build`; the quick-start
  image moved to Alpine 3.23 and Node 24. CI fuzzes the guards on a pull
  request only when it touches one, with a 100,000-run nightly that files a
  "Fuzz counterexample" issue when it finds one.
- **The hosted demo's starting page** shows the boot's progress, step by
  step, in the app's palette, and the docs site wears the app's theme and
  defaults to dark as the app does.
- **One chart style.** Every chart kind now draws its text in the app's font
  at one type scale, with gridlines and no axis lines, 2px series lines, and
  a tooltip on the raised surface with the theme's corners (it was a white
  box in dark). Treemap, pie, donut, Sankey and timeline fills are softened
  toward the surface. A stacked area draws near-solid bands parted by a line
  of surface, so a thin band (a dashboard's error share) stays visible; only
  an unstacked area fades. Custom visuals (Vega) take the same font, sizes
  and gridlines.
- **A new default look.** The default theme, Holotable, keeps its name, its
  font and its square corners, with slightly quieter surfaces and borders and
  a calmer series palette whose colors stay apart under every color-vision
  deficiency the theme checks cover. Its cards are flat now, with no shadow,
  and so are every other built-in theme's. In light, the
  warning is a burnt amber instead of brown, and a spec's `orange` used as
  text is a shade darker than the amber series it stands for. A stored theme
  preference, `THEME_DEFAULT_PALETTE=holotable` and embed links keep working
  and simply look new. A theme file gains an optional `shadow` (`none`,
  `subtle` or `lifted`) and an optional `chart-grid` per scheme; a file
  without them still loads, square and flat like the built-in themes.
- **Status tiles follow the theme's corners.** A status grid's tiles take the
  theme's corner radius, like the panel around them: square everywhere but
  Paper, the one built-in theme that rounds (4px). They were rounded the same
  way in every theme.
- **Amber fills, not brown, in light.** A warning or a spec's `orange` drawn
  as an area (a gauge's arc and bands, a gauge bar, a histogram bar, a
  threshold-colored line, a stat's sparkline, a status tile, a timeline span,
  a log line's stripe) is now a bright amber held to 3:1, while the same
  color as text (a stat's number, a badge) keeps its AA shade. In Graphite,
  Fjord and Paper the amber chart series is raised too, so pie, treemap and
  line series 4, 2 and 3 read amber rather than brown. High contrast is
  unchanged. A theme file gains optional `warning-fill` and `orange-fill`
  tokens per scheme; a file without them fills in its `warning` and `orange`
  as before.
- **Charts fit small panels.** A chart now knows the size it is drawn at and
  fits its text to it: on line, area, bar, histogram and scatter panels a
  value axis draws only as many ticks as fit, hides a tick label that would
  overlap another, and writes large numbers compactly (`60M`) when narrow; a
  legend that does not fit is left out instead of covering the plot, and a
  small scatter drops its axis names. Resizing a panel, the fullscreen
  expand and a window resize update the chart in place. The other chart
  kinds fit too: a dial scales its ring, value and limits to its radius; a
  bar gauge and a state timeline draw the rows that fit and count the rest;
  a pie's legend moves under it or gives way to slice labels, never paged;
  graph and sankey labels are drawn whole, smaller, without values, or on
  hover only; and a narrow heatmap's color scale goes slim. A pie or donut
  with a legend no longer repeats it: a slice carries no outside label or
  leader line, and one large enough shows its share (`42%`) inside, in black
  or white, whichever reads on its fill. With `legend: "none"` (or a legend
  that did not fit), slices are named outside, each name whole, never cut to
  `…`, and never a leader line with nothing at its end.
- **Heatmap and scatter axes.** A heatmap's color scale stands upright on the
  right edge, clear of the time labels, and its handles still filter the
  cells by range. A scatter names both axes in their middle, writes both
  axes' ticks through the panel's `format`, and drops the legend when it has
  one series.
- **Logs and status grids fit their panel.** A log line's layout follows the
  panel's width, not the screen's: in a narrow panel the message goes under
  the time and level, and in a very narrow one the time is the clock alone.
  A status grid whose tiles do not all fit says so, with a fade over its
  bottom edge and an "N more below" that scrolls to them.
- **The account menu says "Color scheme".** Its Light / Dark / System group,
  headed "Theme" before, is "Color scheme", as in Settings and the command
  palette, and it comes first, above Settings. A theme is chosen in Settings →
  Appearance or the command palette.

### Fixed

- The panel editor's Numbers fields (Decimals, Unit, Compact) no longer
  overlap in the narrow side panel, and the demo and local banners' close
  button is centered on its line.
- A menu taller than the window (the chat's Sources menu in a workspace with
  many sources) scrolls inside itself instead of running off-screen (#585).
- The protocol-mismatch message under Test connection names the model's API
  (Responses or Chat Completions) instead of telling the reader to set
  environment variables the form does not have (#591).
- A DuckDB engine opens inside the Docker images on Linux in every time
  zone, and the smoke test runs a panel over its own window when it has one.

### Upgrading

- Migration `026_source_catalog_facts` adds `sources.catalog_facts`; the
  migrate job runs it as usual. A TimescaleDB source shows its engine after
  its next Test or applied Refresh.
- `/dashboards` now redirects to `/` (308). Bookmarks and links keep working;
  update anything that matches the list's path exactly.
- The seeder retires an opt-in demo dashboard (PromQL self-monitoring,
  Holotable logs, Demo files) while it still owns it and its source is off;
  it is restored under the same id when turned back on. A dashboard you
  saved over is never touched. Add the compose `prometheus` or `logs`
  profile, or set `SEED_DEMO_FILES=true`, to keep one.
- The quick-start image runs `AUTH_MODE=local` by default, which lets
  anyone who reaches it manage sources and upload files; it is for one
  person's own machine. Pass `AUTH_MODE=demo` to get the old behavior.
- New variables, all optional: `LOKI_MAX_ENTRIES`, `LOKI_MAX_SERIES`,
  `LOGQL_MAX_RANGE`, `LOKI_SELF_URL`, `DUCKDB_SOURCES_DIR`,
  `DUCKDB_MEMORY_LIMIT`, `DUCKDB_THREADS`, `DUCKDB_UPLOAD_MAX_BYTES`,
  `DUCKDB_UPLOAD_MAX_FILES`, `SEED_DEMO_FILES`, `LOCAL_GROUPS`,
  `LOCAL_MODEL_DETECT`, `LOCAL_MODEL_ENDPOINTS`. `SOURCE_URL_ALLOWLIST` now
  also fences Loki endpoints.
- The default look changed (palette, flat cards, straight lines, one chart
  style). A theme file without the new optional tokens (`shadow`,
  `chart-grid`, `warning-fill`, `orange-fill`) still loads.

### Known limits

- One Node process by design; multi-instance is deliberately not supported
  yet.

## 0.2.0 — 2026-10-11

Two milestones since 0.1.0: scale and render (M17, #484), which closes the
first of 0.1.0's known limits, and themes (M18, #501), which closes the
second.

### Added

- **Themes.** Named palettes beside light and dark, chosen before first paint:
  Holotable, Graphite, Fjord, Paper and a high-contrast theme that also
  follows the operating system's forced colors. A gallery in Settings → Appearance
  picks one; `THEME_DEFAULT_PALETTE` sets what a browser shows first. Every theme is
  held to a quality bar beyond contrast (borders, focus ring, selection, and
  statuses and series that stay distinct under a color-vision deficiency).
- **An operator's own theme.** `THEME_FILE` (Helm: `theme.file`) points at a
  JSON file of token values in both schemes, checked against that bar at
  boot; `npm run themes:export` writes a valid starting point.
- **Charts are tokens.** Series, ramps and a spec's color tokens are read from
  the page per scheme and theme, so a chart follows the theme like the rest of
  the app.
- **Embeds and share links carry a theme.**
- **Truncation is visible.** Every cut (rows, bytes, points, the browser's
  window) shows as a badge on the panel; the row cap keeps the newest rows
  when the query has a time field.
- **Windowed table and logs panels.** They render only the rows on screen,
  hold the whole result, and take a `limit` option.
- **Capacity metrics.** Pool waits, poller skips, SSE bytes and drops,
  truncations and model calls in flight, on `/api/metrics`.
- **Retention on a timer.** `RETENTION_SWEEP_INTERVAL_MS` sweeps generation
  logs, conversations and messages hourly, so a quiet workspace is swept
  too.

### Changed

- **Version history is capped.** `DASHBOARD_VERSIONS_KEEP` (default 100)
  removes a dashboard's oldest versions past it on save, never the current
  one. Set it to `0` to keep every version, as 0.1.0 did.
- **Model calls are admitted, not just counted.** Tokens are reserved before a
  call starts, and `LLM_MAX_IN_FLIGHT` (default 16) caps model calls in flight
  across the server; past it a call gets 429 with `Retry-After`.
- **Memory has a ceiling.** `MAX_POLLERS` caps dashboard pollers (by default
  derived from the heap); the Helm chart sets Node's heap to three quarters of
  `resources.limits.memory` and fails the render below 256Mi.
- **The point budget is 1,000.** `MAX_WINDOW_POINTS` rose from 720 to equal
  `PROMQL_MAX_POINTS`, so a PromQL series fits its panel whole.
- **Model requests get 90 seconds.** `AI_REQUEST_TIMEOUT_MS` defaults to
  90,000 (was 45,000) and every model-backed route ends at 120 seconds.
- **Faster under load.** One render per tick with memoized panels; ECharts
  loads with the first chart and only the series in use; the dashboard chat
  loads on demand; the source pool reads once per tick under a slot cap;
  SSE serializes once and drops a stalled subscriber after `SSE_SLOW_TICKS`
  (default 3), which reconnects and resumes.

### Fixed

- Signing back in within the second of a sign-out no longer answers 401
  (#542).
- A newest-first table's appends land on top (#531); a panel's window drops
  rows the server's result no longer holds (#530); crosshair sync finds the
  right category.
- A button that is busy with its own work keeps keyboard focus instead of
  dropping it to the page, which also keeps focus in the Share dialog while
  it creates a link (#540); a chart's screen-reader table no longer scrolls
  the page sideways (#536).

### Upgrading

- Migration `025_audit_log_time_index` adds an index on `audit_log (workspace_id, at)`; the
  migrate job runs it as usual.
- Check `DASHBOARD_VERSIONS_KEEP` if you rely on every version being kept.
- Under Helm, a `resources.limits.memory` below 256Mi now fails the render.

### Known limits

- One Node process by design; multi-instance is deliberately not supported
  yet.

## 0.1.0 — 2026-10-11

The first tagged release. Nothing here is new to someone following `main`;
the point of the tag is that the images, the Helm chart and the docs now name
a version, and `SECURITY.md` has a line to say which one is supported.

### What Holotable is at 0.1.0

- **Describe a dashboard, get a validated spec.** A model writes the spec
  (queries and chart configuration), never the data; one Zod IR is the
  contract between generation, the API, storage and the browser, versioned
  with upgraders so a stored dashboard keeps opening.
- **Every query is guarded.** SQL is SELECT-only, built from an allowlisted
  parse tree, bounded by rows, bytes and time, scoped by row-level filters,
  with variables bound as parameters. PromQL has its own parse-tree guard.
  The server owns the time window. Whoever wrote the query, it goes through
  the guard.
- **Sources.** TimescaleDB/PostgreSQL and Prometheus-compatible endpoints,
  through a source-kind registry; credentials sealed at rest or resolved from
  server-side `secret_ref`s, never sent to the browser; table and metric
  discovery; a connection test.
- **Panels.** Line, area, bar, scatter, heatmap, pie and donut, histogram,
  gauge, state timeline, treemap, stat, status grid, table, logs, text, and
  custom Vega-Lite visuals; panel options (thresholds, formats, legends, axes);
  variables; annotations; drilldown links that carry the window and the
  variable picks; share and embed links.
- **Live dashboards.** Server-side pollers stream rows over SSE to every
  viewer of the same dashboard and window; charts merge updates and are never
  recreated; pause, time travel, fullscreen, PNG export, version history with
  diffs.
- **Explore and chat.** Ask a question in words and get a panel; talk to a
  dashboard to change it; conversations are kept, with their model, and a
  panel can be handed to a dashboard.
- **Models.** A provider registry (OpenAI, Anthropic, Google, AI Gateway,
  Azure OpenAI, Amazon Bedrock, Mistral, xAI, any OpenAI-compatible endpoint),
  a catalog of server, workspace and personal models, a per-request pick, and
  per-workspace limits on requests and tokens.
- **Identity and authorization.** Keycloak OIDC is the only sign-in;
  authorization is `can()` from the token's groups; workspaces; service-account
  tokens for automation; MCP access tokens; an audit log of every mutation.
- **Integrations.** An MCP server and a Claude Code skill over the same IR and
  guards the UI uses.
- **Operations.** Multi-arch images (`runtime`, `migrate`, `quickstart`); a
  Helm chart with a migration hook, a PodDisruptionBudget and an HPA;
  migrations with declared rollback paths; `/api/health`; Prometheus metrics;
  structured logs that carry digests, never credentials, SQL or prompts;
  self-monitoring dashboards; a CSP with nonces; guarded outbound fetches.
- **Getting started.** One all-in-one quick-start image with demo data and no
  sign-in (`AUTH_MODE=demo`), Docker Compose with a local Keycloak, a hosted
  demo, first-run onboarding and starter templates from your own catalog.
- **Accessibility and motion.** WCAG AA token pairings held by a test, axe
  scans of every surface in both themes, charts with data tables and optional
  patterns, a motion preference that beats the OS, keyboard navigation and a
  command palette.

### Known limits

- Large results are cut without saying so: 720 points per panel in the
  browser, 5,000 rows and 4 MiB per query on the server, and the live edge is
  the part dropped for SQL series. Tracked in M17 (#484), with the source
  pool's capacity and SSE backpressure.
- One designed palette, in light and dark. Named themes, a high-contrast theme
  and operator-defined themes are M18 (#501).
- One Node process by design; multi-instance is deliberately not supported yet.
