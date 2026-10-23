# Changelog

What changed for people who run or use Holotable, by release. The GitHub
release page carries the matching section below, followed by the list of
pull requests merged since the previous tag. `CONTRIBUTING.md` ("Releasing")
says how a section gets here.

## Unreleased

### Added

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
- **One chart style.** Every chart kind now draws its text in the app's font
  at one type scale, with gridlines and no axis lines, 2px series lines, and
  a tooltip on the raised surface with the theme's corners (it was a white
  box in dark). Treemap, pie, donut, Sankey and timeline fills are softened
  toward the surface. A stacked area draws near-solid bands parted by a line
  of surface, so a thin band (a dashboard's error share) stays visible; only
  an unstacked area fades. Custom visuals (Vega) take the same font, sizes
  and gridlines.
- **Status tiles follow the theme's corners.** A status grid's tiles take the
  theme's corner radius, like the panel around them: square in a square
  palette, softened where a palette rounds its corners. They were rounded the
  same way in every theme.
- **A new default look.** The default palette, Holotable, keeps its name, its
  font, its square corners and its flat cards, with slightly quieter surfaces
  and borders and a calmer series palette whose colors stay apart under every
  color-vision deficiency the theme checks cover. Cards no longer draw a
  shadow. In light, the warning is a burnt amber instead of brown, and a
  spec's `orange` used as text is a shade darker than the amber series it
  stands for. A stored palette preference, `THEME_DEFAULT_PALETTE=holotable`
  and embed links keep working and simply look new. A theme file gains an
  optional `shadow` (`none`, `subtle` or `lifted`) and an optional
  `chart-grid` per scheme; a file without them loads as before, square and
  subtly lifted unless it says otherwise.
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
  hover only; and a narrow heatmap's color scale goes slim.
- **Pie and donut labels no longer repeat the legend.** With a legend, a
  slice carries no outside label or leader line; a slice large enough for
  it shows its share (`42%`) inside, in black or white, whichever reads on
  its fill. With `legend: "none"` (or a legend that did not fit), slices are
  named outside, each name whole, never cut to `…`, and never a leader line
  with nothing at its end (#638).

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
