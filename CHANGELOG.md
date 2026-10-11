# Changelog

What changed for people who run or use Holotable, by release. The GitHub
release page carries the matching section below, followed by the list of
pull requests merged since the previous tag. `CONTRIBUTING.md` ("Releasing")
says how a section gets here.

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
