# Changelog

What changed for people who run or use Holotable, by release. The GitHub
release page carries the matching section below, followed by the list of
pull requests merged since the previous tag. `CONTRIBUTING.md` ("Releasing")
says how a section gets here.

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
