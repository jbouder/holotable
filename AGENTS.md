# AGENTS.md

## Purpose

Holotable is a **natural-language dashboard builder for monitoring data**.

Users describe the dashboard they want in plain English. The model generates a
**validated dashboard specification** (not the underlying data), and the app
executes guarded SQL against TimescaleDB/PostgreSQL to render live dashboards.

When making changes, preserve these product invariants:

- The LLM generates **specs**, never raw metric values.
- The **shared Zod IR** is the contract between generation, persistence, APIs,
  and rendering.
- SQL emitted or handled by the system is **untrusted** and must stay guarded.
- The **server** is the authority for time windows and execution constraints.
- Credentials/secrets must never be persisted in dashboard specs.

---

## Framework warning: treat this as Next.js 16, not generic “Next.js”

This repository uses:

- `next@16.2.10`
- `react@19.2.7`
- App Router
- Tailwind CSS v4

Do **not** assume behavior from older Next.js or React versions.

Before changing framework-sensitive code, consult the installed docs in:

- `node_modules/next/dist/docs/`
- the current patterns already used in this repository

Be especially careful around:

- Server vs Client Component boundaries
- routing/navigation APIs
- request/runtime behavior in route handlers
- streaming/data-fetching patterns
- build/runtime config
- React 19 behavior

Prefer following existing repository patterns over generic prior knowledge.

---

## Repository structure

Key locations:

- `src/app/` — App Router routes, layouts, pages, API routes
- `src/components/` — UI and feature components
- `src/lib/` — shared domain logic, schemas, formatting, utilities
- `scripts/` — migration, seeding, integration-runner and fixture-capture
  scripts
- `test/` — Node test runner tests (`*.test.ts`; `*.test.tsx` for the few that
  need a real render, via the jsdom harness in `test/support/dom.tsx`)
- `docs/` — the Astro + Starlight documentation site (its own `package.json`;
  content under `docs/src/content/docs/`)
- `e2e/` — the Playwright suite (`npm run e2e`): journeys and axe scans
  against its own stack in `e2e/compose.yml`, signed in through the realm
- `timescaledb/` — database bootstrap/schema assets
- `deploy/` — the Helm chart (`deploy/helm/holotable/`, with runnable example
  values under `examples/`), a reference Argo CD `Application`, and the
  all-in-one quick-start image (`deploy/quickstart/`: TimescaleDB, the server
  and the demo jobs under one `entrypoint.sh`, in demo mode), and the hosted
  demo (`deploy/cloudflare/demo/`: a Worker with per-IP limits fronting one
  Cloudflare Container on that image; its own `package.json`, excluded from the
  root `tsconfig`, checked by `.github/workflows/demo.yml`)
- `.github/` — CI workflows, issue forms, the pull request template, `CODEOWNERS`,
  `dependabot.yml`
- `.claude/skills/holotable/` — the `/holotable` Claude Code skill (#147):
  knowledge-only guidance for writing and reviewing specs, with no server
  connection. `test/holotable-skill.test.ts` runs its examples through the IR
  and the SQL guard and holds its lists of panel kinds, formats and color
  tokens to the code, so a change to any of those updates the skill's
  `references/` in the same pull request

Important files:

- `src/lib/ir.ts` — the canonical shared dashboard IR schema
- `src/lib/ir/upgrade.ts` — the upgrader chain that brings a stored spec of any
  earlier `specVersion` up to the current one before it is validated
- `src/lib/panels/registry.ts` — the panel kinds (#61). `VizType`, the
  generation prompt's viz list and the docs reference are built from it; each
  kind is a module under `src/lib/panels/kinds/`, and its renderer is one line
  in `src/components/panels/registry.ts`, which does not compile without one.
  Never add a `switch` on `panel.viz`: register the kind instead. A kind
  declares its `options` schema (validated as `panel.options`), whether it
  runs a query at all (`query: "none"` for text, #202) and whether it needs a
  time field. `panel.query` is optional because of that: anything that
  executes, validates, lists or re-points queries filters with `hasQuery`.
  Text-panel Markdown is rendered by `src/lib/markdown.ts` into React
  elements, never as an HTML string. Options several kinds share (numbers,
  legend, axis, thresholds, #115) are fragments in
  `src/lib/panels/presentation.ts`; a kind's `optionGroups` names the ones
  the editor draws controls for. A panel's own `timeRange` and
  `refreshIntervalMs` (#114) are read through `panelTimeRange` and
  `panelRefreshMs`; the poller groups panels by cadence under one timer
- `src/lib/sources/registry.ts` — the source kinds (#382, ADR 2), as the panel
  registry is the panel kinds. `SourceConfig` is the union of every kind's
  config on `kind`; a kind's browser-safe module is under
  `src/lib/sources/kinds/` (config schema, `connection`, `catalog`, `listing`,
  `language`) and its server half under `src/lib/sources/server/`
  (`discover`, `refresh`, `test`, `validate`, `plan`, `execute`, the catalog
  prompt). Never compare `source.kind` or import `src/lib/timescaledb/` from a
  route: ask `sourceKind(record)` or `serverKind(record)` and use what comes
  back. `test/source-kinds.test.ts` fails on either outside `src/lib/sources/`
- `src/lib/sql/safety.ts` — the SQL guard every generated query passes through
- `src/lib/sources/server/types.ts` — `ServerSourceKind`, the one shape every
  kind's server half has (#385): `check`, `plan`, `execute`, `planView`,
  `labelValues`, `test`, `checkConfig`. The poller, `/api/query`, `/api/sql/*`,
  variables, chat and the MCP tools call it and never ask which language they
  hold; each kind refuses a query in the other language itself. SQL-only
  management (discover, refresh, hide a column) is behind `requireSqlSource`
  until #386. `src/lib/prometheus/` is the HTTP client (guarded fetch under
  `SOURCE_URL_ALLOWLIST`, credentials per request, byte cap as the body
  arrives) and the conversion of results to wide rows
- `src/lib/promql/` — the PromQL guard (#384), the same guard for a
  Prometheus source: `parse.ts` (the real grammar, `@prometheus-io/lezer-promql`),
  `safety.ts` (`validatePromql`: allowlisted node types, the metric allowlist,
  `@` refused, ranges bounded by `PROMQL_MAX_RANGE`, variables only as a
  matcher's whole value), `variables.ts` and `row-filter.ts` (the rewrites,
  each verified by re-parse) and `plan.ts`. `npm run test:fuzz` runs its fuzz
  suite beside the SQL one
- `src/lib/sql/ast.ts` — the PostgreSQL parse-tree walk the guard is built on
- `src/lib/sql/row-filter.ts` — row-level filters (#31): every real table a
  statement reads is spliced, at the parser's byte offsets, into a subquery
  narrowed to the viewer's rows, and the result is re-parsed and verified.
  `buildExecutablePlan` takes `rowFilter` as a required input; bind it with
  `rowFilterFor`/`rowFilterInScope` (`src/lib/row-scope.ts`), which refuse a
  viewer without the claim. Pollers are keyed by the claim values (`RowScope`)
- `src/lib/sql/variables.ts` — dashboard variables in SQL (#67): `:name`
  references are found by PostgreSQL's scanner, never a regex, and become `$n`
  placeholders bound after the time and row-filter parameters; a value never
  enters the text. `validateSql`/`checkSql` take the declared names, and a
  caller that validates a dashboard's panel SQL passes
  `declaredVariables(spec)`. Which values a viewer may bind is
  `src/lib/variables.ts` (a `query` variable's guarded SELECT, in the
  dashboard's workspace, under the viewer's row scope) and
  `src/lib/variable-selection.ts` (`var-*` URL picks, defaults, the allowlist
  check). Picks are part of the poller key
- `src/lib/drilldown.ts` and `src/lib/drilldown-targets.ts` — drilldown
  (#370): a panel's `links` name a target dashboard by opaque id, never a URL.
  The page resolves targets on the server (same workspace, `can()` on every
  load) and the browser builds hrefs only to those; an href carries time
  expressions and `var-*` picks, which the target re-checks like a typed URL.
  Share links and embeds show no links. A click maps back to its row through
  `datumOf` in `src/lib/drilldown-datum.ts`, one mapping per panel kind (a new
  kind does not compile without one); the clickable bodies read
  `useDatumLinks()` from `src/components/dashboard/DatumLinks.tsx`
- `src/lib/annotations.ts`, `src/lib/annotation-service.ts` and
  `src/lib/db/annotations.ts` — annotations (#68): workspace-scoped events
  drawn on time-series panels. Reads take the workspace from the dashboard
  record, writes from the path, and every statement filters on it
- `src/lib/auth/share.ts` and `src/lib/auth/share-access.ts` — read-only
  share links (#65): signed `hts_` tokens checked against a hashed, revocable
  row on every use, resolving to an identity `can()` allows `dashboard:view`
  on one dashboard and nothing else. Only the stream route and
  `src/app/embed/` accept one, never `getIdentity()`; `test/share.test.ts`
  holds that list. The page gets `sharedSpec()` (no SQL or source ids)
- `src/lib/auth/mcp-token.ts` — how an MCP client authenticates (#149): the
  one route that accepts a realm-issued access token is `/api/mcp`, in a
  bearer header, minted for the public `OIDC_MCP_CLIENT_ID` client (`aud` and
  `azp`), verified on every request and refused once its `sid` is revoked.
  The 401 challenge and `/.well-known/oauth-protected-resource` send the
  client to the realm itself; Holotable mints nothing. `getIdentity()` never
  reaches it, `verifySessionToken` refuses a token minted for that client,
  and `test/mcp-auth.test.ts` holds the list of routes that import it
- `src/lib/mcp/` — the MCP server behind `/api/mcp` (#148): `protocol.ts` is
  the stateless streamable-HTTP JSON-RPC layer (no sessions, no SSE, no
  dependency; the official SDK's client drives it in `test/mcp-client.test.ts`),
  `tool.ts` is what a tool is (one zod schema validates the arguments and,
  as JSON Schema, documents them; a failure is `isError`, never a protocol
  error), and `tools/` are thin façades over the same functions the HTTP
  routes call, each with the route's `assertAuthorized` and audit event
  (`test/audit.test.ts` holds that) and reached through `McpDeps` so tests
  hand in fakes. A tool returns specs and guarded rows, never a connection
  detail or a credential; generation repairs a schema failure once, inline,
  as a second admitted model call
- `src/lib/auth/authorize.ts` — the central `can()` check
- `src/lib/auth/renewal.ts` — session renewal (#27): the realm's refresh token
  is sealed in `sessions` (`refresh-token.ts`) and never reaches the browser,
  which holds only an opaque id in a cookie scoped to `/api/auth`. Renewal
  re-derives the groups from the realm's fresh id_token; it is not on the
  request path, which still verifies the stateless session token alone
- `src/lib/auth/revocation.ts` — sessions ended before their tokens expire
  (#28): back-channel logout and sign-out revoke by the realm `sid` the token
  carries, `verifySessionToken` consults the set on every request, and open
  dashboard streams listen for it and close. Process-local, because the app is
  one instance by design
- `src/lib/auth/stream-guard.ts` — how long an open dashboard stream stays
  authorized (#32): it ends at its token's expiry, on revocation, and when the
  re-check every `SSE_REAUTH_INTERVAL_MS` finds the dashboard no longer
  viewable. A stream cannot see a renewed cookie, so expiry ends it and the
  browser reconnects and resumes
- `src/lib/audit.ts` — the append-only audit log (#30). `audit()` is
  fire-and-forget and never fails a request; `auditRow` is the one place a row
  is built and redacted. A new mutating route, or a new kind of execution,
  records its event here and adds it to `AUDIT_ACTIONS`; `test/audit.test.ts`
  holds each action to the route that emits it. `assertAuthorized` records
  refusals itself, and takes the resource as an optional fourth argument
- `src/lib/settings.ts` — the `/settings` sections as data. A new section is
  an entry here and a page under `src/app/settings/<id>/`; a gated section
  also calls `notFound()` from its page, because hiding the link is never the
  only check. The header's account menu (`src/components/profile-menu.tsx`)
  links into it
- `src/lib/preferences.ts` — the per-user preferences stored server-side in
  `user_preferences`. Theme and motion are deliberately not in it: they are
  applied by the root layout's inline script before first paint and stay in
  `localStorage`. The file header records which choices sync and why
- `src/lib/account.ts` — the `GET /api/me` summary and the role descriptions
  on the account page, derived from `can()`. `Identity.displayName` and
  `email` are display-only and must never feed an authorization decision
- `src/lib/time.ts` — server-side time expression/range resolution
- `src/lib/registry.ts` — source registry: safe connection config and catalog
- `src/lib/secrets/credentials.ts` — `secret_ref` resolution: the
  `SOURCE_SECRET_REFS` workspace grant, checked on every connection, then the
  credentials from `SOURCE_SECRETS_DIR` files or the environment. Server-only;
  the browser-safe half (grant parsing, readiness) is `src/lib/secret-refs.ts`
- `src/lib/security-headers.ts` and `src/proxy.ts` — the header baseline and
  the per-request Content-Security-Policy nonce; an inline `<script>` or
  `<style>` needs the nonce or the browser blocks it
- `src/lib/metrics.ts` and `src/lib/metrics-access.ts` — the Prometheus
  instruments and the gate on `/api/metrics`; a scrape is unauthenticated by
  session, so the endpoint stays closed until `METRICS_TOKEN` or
  `METRICS_ALLOWED_CIDRS` is set
- `src/lib/log.ts` and the `route()` wrapper in `src/lib/http.ts` — the JSON
  log, the per-request `AsyncLocalStorage` context, and the redaction pass
  every payload goes through; a log line never carries a credential, and SQL
  and prompt text is reduced to a digest
- `src/lib/ai/log.ts` — the generation log: one redacted prompt/spec pair per
  model call. `redactPrompt` is deliberately more aggressive than the log's
  `redactString` (it also eats `*_API_KEY`-family assignments and long
  base64/hex runs), the catalog is kept as a hash rather than as text, and a
  write that fails is dropped rather than failing the generation. The only
  reader is `GET /api/generation-log`, behind `source:manage`
- `src/lib/ai/invoke.ts` — the deadline and jittered retry on every model
  request (#22), as a model middleware `getModel()` applies. A new
  `streamObject`/`streamText` call spreads `...modelSettings()` from
  `provider.ts`, which also turns the SDK's own retry off and carries the
  `onError` that logs a failed call through `log` instead of the SDK's raw
  console dump (#343); `test/ai-invoke.test.ts` fails on a call site that does
  not, or that sets its own `onError`
- `src/lib/ai/model-resolution.ts` and `src/lib/ai/model-config.ts` — models
  configured in the app (#331): per request, the caller's personal model (when
  the workspace allows personal keys), else the workspace's, else the
  environment's. A generation route calls `requireModel` before the limits and
  hands `resolved.model` to the stream, which spreads `...modelSettings(model)`;
  `resolved.source` goes on the generation log row and the audit event. The
  key is sealed (`src/lib/secrets/seal.ts`, its own HKDF label), never
  returned, and registered with the log's redaction (`rememberSecret`) when it
  is opened. The base URL is untrusted: `ai/base-url.ts` holds the rules and
  `ai/guarded-fetch.ts` applies them at DNS time on every connection. Both
  levels are off in demo mode
- `src/lib/ai/repair.ts` and `src/components/use-repairing-object.ts` — the
  one automatic repair of output that failed its schema (#21). The browser
  sends only `{ repairOf: id }`; the request, the rejected output and the
  issues come from the server's process-local store, and taking an entry
  removes it. A new generation surface uses `useRepairingObject`, not
  `useObject`, and its route remembers failures the way `/api/generate` does
- `src/lib/workspace-prompt.ts`, `src/lib/ai/prompt.ts` and
  `src/lib/workspace-prompt-service.ts` — per-workspace prompt customization
  (#66): a glossary, metric definitions and example panels that `baseSystem`
  puts in a fenced `WORKSPACE_CONTEXT` block between the catalog and the rules.
  Every field is capped, so the prompt stays bounded; an example's SQL passes
  the guard against a live source in the same workspace before it is saved,
  and again against the current catalog before it is shown to the model
- `src/lib/ai/prompt-dashboards.ts` and `src/lib/ai/link-targets.ts` — what a
  generation may link to (#375): the workspace's dashboards the caller may
  view, as a fenced `DASHBOARDS` block (`dashboardsBlock` in
  `src/lib/ai/prompt.ts`). A generated link to any other id fails the schema
  on the server and, through the `X-Link-Targets` header that
  `useRepairingObject` reads, in the browser, so the one repair runs
- `src/lib/self-monitoring/` — the committed self-monitoring demo: the
  dashboard spec (also an IR snapshot), the source catalog, and the Prometheus
  text-format parser the collector uses. `test/self-monitoring.test.ts` holds
  the spec, the catalog and the collector's metric allowlist to one contract,
  so a panel cannot be written against a metric nothing collects
- `src/app/globals.css` — design tokens and Tailwind v4 theme setup
- `next.config.ts` — standalone output, `pg` externalization
- `package.json` — authoritative scripts/tooling
- `SECURITY.md` — the trust model and the disclosure process
- `CONTRIBUTING.md` — the human-facing version of this file

The paths with a `CODEOWNERS` entry (`src/lib/sql/`, `src/lib/promql/`, `src/lib/auth/`,
`src/lib/secrets/`, `ir.ts` and `ir/`, `time.ts`, `registry.ts`,
`metrics-access.ts`, `row-scope.ts`, `variables.ts`, `variable-selection.ts`,
`ai/base-url.ts`, `ai/guarded-fetch.ts`) are
the ones where a quiet regression stops being a bug and becomes a
vulnerability. Changes there need a test.

For `src/lib/sql/` that test is often already written for you:
`test/sql-safety.fuzz.test.ts` generates statements from adversarial shapes and
checks that poisoned ones are rejected, benign ones accepted, and accepted ones
satisfy an independent parse-tree oracle. Run `npm run test:fuzz` after any
guard change; a failure prints the statement and a replay line. Promote the
counterexample into `test/fixtures/sql-fuzz-corpus.ts` and a named test rather
than adjusting the generator to avoid it. `src/lib/promql/` has the same
pair: `test/promql-safety.fuzz.test.ts`, with its corpus in
`test/fixtures/promql-corpus.ts`, and `npm run test:fuzz` runs both.

Component tests are deliberately rare. `react-dom/server` does not run error
boundaries — a throwing child propagates straight out of `renderToStaticMarkup`
— so anything that depends on a real React unwind mounts through
`test/support/dom.tsx` (jsdom, devDependency only) and is named `*.test.tsx`.
Prefer extracting the logic into `src/lib/` and testing it as a function; reach
for a render only when there is nothing to extract.

---

## Core architectural rules

### 1) The shared IR is the contract

`src/lib/ir.ts` defines the single shared Zod schema used across:

- model output
- API validation
- persistence
- client rendering

If you change dashboard structure, panel structure, value formats, or time
expressions:

- update the Zod schema first
- keep types inferred from Zod
- update all producers/consumers consistently
- do not create parallel ad hoc shapes that drift from the IR

Avoid “temporary” incompatible types.

Saved specs cannot be regenerated, so a change that would make a stored spec
fail to parse (a renamed or removed field, a new required one, a dropped viz
type) is a **breaking** change:

- bump `SPEC_VERSION` in `src/lib/ir.ts`
- append the upgrader from the previous version to `UPGRADERS` in
  `src/lib/ir/upgrade.ts`: a pure function on plain JSON that imports nothing
  from `ir.ts`
- test it against a fixture of the previous version. `test/ir-contract.test.ts`
  (#90) holds every spec in `test/fixtures/specs/` to loading, passing the
  guard and planning as its snapshot says; a fixture is never edited (its
  digest is in `index.json`), so add fixtures of the new version beside the
  old ones (`npm run fixture:capture` reads one from a live dashboard). The IR's
  JSON Schema is snapshotted in `test/snapshots/`; rewrite both snapshots with
  `UPDATE_SNAPSHOTS=1 npm test` and review the diff
- read any spec you did not just build (a database row, a template, a file, a
  draft, a request body) through `StoredDashboard`, never `Dashboard` directly
- check the SQL that reads raw `spec` jsonb without upgrading it: the version
  history's panel count (`VERSION_COLUMNS` in `src/lib/db/repo.ts`) and the
  source-impact queries assume `panels` is a top-level array

An additive, optional field needs none of this.

### 2) The model must not generate data

The model may generate dashboard/panel specifications and SQL, but not actual
result datasets.

Do not introduce flows where:

- the LLM returns metric data
- the client trusts model-produced data points
- rendered charts bypass server-side query execution

### 3) Treat all model SQL as untrusted

Even when a query originates from the app or model, treat it as untrusted input.

Preserve or strengthen guardrails such as:

- SELECT-only behavior
- read-only execution
- disallowing dangerous/non-deterministic constructs where applicable
- row/time/window limits
- allowlists and catalog-driven access
- server-controlled time filtering

Never weaken SQL validation or execution constraints for convenience.

### 4) The server owns time

The server is the source of truth for concrete time ranges.

The IR may carry relative expressions like `now-15m`, but actual resolution and
enforcement belong on the server. Avoid pushing authoritative time-window logic
into the client or model.

### 5) Source references must stay opaque

Panels should reference data sources through stable IDs, not embedded connection
details or credentials.

Do not store secrets, raw credentials, or unsafe connection information in:

- dashboard specs
- panel configs
- client-visible payloads

---

## UI and design conventions

This app uses a dark monitoring-dashboard aesthetic with tokens defined in
`src/app/globals.css`.

### Styling rules

- Use **Tailwind CSS v4** utilities and existing theme tokens.
- Reuse the CSS variables/tokens already defined in `globals.css`.
- Every text/background token pairing meets WCAG AA in both themes;
  `test/contrast.test.ts` measures them (`src/lib/color/contrast.ts`) and the
  table in `docs/src/content/docs/architecture/accessibility.md`. A new
  pairing goes in `CONTRAST_PAIRS`. A chart goes through `AccessibleChart`,
  a link styled as a button is `ButtonLink` (never `<Link><Button>`), and an
  icon-only control has an `aria-label`. `npm run e2e` scans with axe.
- Prefer existing composition helpers like `cn()` from `src/lib/utils.ts`.
- Reuse existing UI primitives in `src/components/ui/` before adding new ones.
- Keep styling consistent with current surfaces, borders, muted text, and
  primary accent usage.

### Component rules

- Prefer small, composable components.
- Keep presentational logic separate from domain/data logic when practical.
- Put reusable domain logic in `src/lib/`, not inside page components.
- Use `"use client"` only when required by hooks, browser APIs, or client-only
  interactivity.

### Visualization rules

The repo uses ECharts.

When working on charts/panels:

- preserve stable rendering behavior
- avoid unnecessary chart recreation
- prefer incremental updates / existing data-flow patterns
- keep chart colors compatible with the token system

Note: design tokens are authored in OKLCH and may need runtime conversion before
being passed to ECharts.

### Motion rules

Motion is platform-only and gated by the preference in `src/lib/motion.ts`,
which the root layout resolves onto `<html data-motion="reduce|allow">`
before first paint (#212). The rules:

- **Platform only.** View Transitions, the Web Animations API,
  `@starting-style`, and FLIP. No framer-motion, motion, react-spring,
  auto-animate, or tw-animate-css.
- **Tokens, not literals.** Durations are `duration-(--duration-fast|base|slow)`
  and curves are `ease-standard` / `ease-emphasized`, all from `globals.css`.
  No `duration-150`, no `ease-in-out`. JS that cannot read a CSS variable uses
  `EASE_EMPHASIZED` / `DURATION_BASE_MS` from `src/lib/motion.ts`.
- **Animate `opacity` and `transform` only** (`translate`, `scale`). A
  position or size change goes through FLIP or a view transition, never a
  transition on `top`, `height`, or `margin`. The one sanctioned height
  transition is Base UI's Collapsible, which measures the panel into
  `--collapsible-panel-height` for you (the nav-bar mobile menu).
- **One switch.** Every motion rule keys off `:root[data-motion]`; never
  `motion-safe:`, `motion-reduce:`, or `@media (prefers-reduced-motion)`
  directly, because "Allow" deliberately beats the OS. The global reduce rule
  in `globals.css` stills CSS; the JS helpers (`animateOut` in
  `src/lib/motion.ts`, `withViewTransition` in `src/lib/view-transition.ts`)
  take `enabled` from `!useReducedMotion()` in a component or
  `isMotionActive()` outside React. `view-transition.ts` imports `flushSync`
  and so is client-only; `motion.ts` is reached by Server Components through
  `src/lib/bootstrap.ts` and must stay free of React imports.
- **Overlays use Base UI's hooks.** Enter and exit are
  `data-starting-style:` / `data-ending-style:` variants on the popup; Base UI
  keeps the element mounted until `transitionend`, which is why the reduce
  rule clamps to `0.01ms` rather than `0`. Something that is not a Base UI
  popup uses the `fade-in` utility (enter only, it just unmounts) or, when
  the exit is worth seeing, `src/components/notice.tsx` over the `notice`
  utility, which stays mounted and toggles `data-open`. A two-branch render
  (`DashboardChat`) runs `animateOut` before flipping its state.
- **Scope view-transition names.** `withViewTransition(update, enabled, type)`
  puts `type` on `<html data-vt>` for the life of the transition; a
  `view-transition-name` is always written as `html[data-vt="<type>"] .thing`
  (the `html` type selector, not `:root`, so the reduce rule outranks it).
  Types in use: `theme` (`src/lib/theme-transition.ts`, the only way client
  code changes the theme) and `tab` (the version history's Changes/Preview tab
  list; `.tab-panel` on exactly one element per tab).
- **Entrances are keyframes.** `stagger-in` (with `--i` inline for a list),
  `drop-in` (alerts) and `pop-in` (an icon that swapped because something
  happened) in `globals.css`. Keyframes, not `@starting-style` transitions,
  so they can share an element with `transition-colors`; `backwards` fill so
  nothing is held after. No `--i` on a stream (chat messages): the newest
  item must not wait behind the others.
- **Lists FLIP, deletes leave first.** A list that reorders, reflows or
  filters calls `useFlip(containerRef, enabled)` from
  `src/components/use-flip.ts` and marks each item with `data-flip-id`
  (`FlipGroup` wraps a server-rendered list). A delete runs `animateOut` on
  the row before the dispatch or `router.refresh()`, so the others slide
  into a real gap. Never FLIP the thing under the pointer; `DashboardGrid`
  takes `pinnedId` for that.
- **Charts merge, never recreate.** FLIP a panel's card, never its chart;
  `EChart`'s `ResizeObserver` picks up the final size. The fullscreen expand
  in `PanelView` and the dashboard chat's expand are the single-element size
  FLIPs (`flipFrom` in `src/lib/motion.ts`): `translate` and `scale` on the
  same element, measured before the class swap.
- **Pages enter through `src/app/template.tsx`.** Its `.page` element is new
  on every navigation and carries the only whole-page entrance; a page never
  adds another. Next's `experimental.viewTransition` is off on purpose; see
  #238 for what has to hold before it goes on.
- **Spinners freezing under Reduce is intended.** `animate-spin` and
  `animate-pulse` become a single frame at `0.01ms`; do not "fix" it.

---

## Data, auth, and infra conventions

### Database

This project uses PostgreSQL/TimescaleDB-related flows.

Be careful when changing:

- schema assumptions
- source configuration objects
- migration scripts
- seed behavior
- polling/streaming logic
- query execution boundaries

Prefer additive, migration-safe changes.

### Auth

Keycloak OIDC is the **only** way to authenticate a real user. There is no
local login, no password store, no dev-login bypass, and no seeded user —
`src/app/api/auth/` has exactly five routes (`login`, `callback`, `logout`;
`refresh`, which renews a session only from a fresh realm-issued id_token and
never mints one on its own, #27; and `backchannel-logout`, which only ever
ends sessions, #28).
Do not add a development-only authentication path; make the local Keycloak
work instead.

The one exception is `AUTH_MODE=demo` (#251), for evaluation and the public
demo only. In it `/api/auth/login` mints an ordinary first-party session for
every visitor, with no login screen, holding `DEMO_GROUPS`; `callback` is a
404. The exception is in *minting*, never in *verification*:
`verifySessionToken`, the claims parser and `can()` are unchanged, and a demo
session is checked exactly like any other. Its guards are boot errors in
`validateConfig` and must stay that way: demo mode refuses any `OIDC_*`
variable, and refuses `DEMO_GROUPS` that reach `source-admin` or
`/platform-admins`. It is **not** a way to develop auth code. Anything that
touches `src/lib/auth/`, the session or the claims still runs against the
realm.

Two credentials are not people, and neither is a way in for one:

- **Service-account API tokens** (#288, `src/lib/auth/api-token.ts`):
  `Authorization: Bearer ht_…`, minted by a source-admin under
  `/settings/tokens`, hashed in `api_tokens`. A token resolves to one
  workspace at viewer or editor, never source-admin or platform admin, and
  `can()` decides its requests from that role exactly as for a person. It
  cannot open a dashboard stream or manage tokens.
- **Share links** (#65): view one dashboard, and only through the stream and
  `src/app/embed/`.

Authorization is derived exclusively from the validated identity token's
`groups` claim (or, for a service-account token, its row's single role) and
is centralized in `can()` (`src/lib/auth/authorize.ts`).
Group paths map to per-workspace roles, highest role wins, and parsing fails
closed (`src/lib/auth/claims.ts`).

When touching auth:

- preserve secure defaults
- do not broaden access implicitly
- never derive authorization from a workspace id supplied in a request
- re-authorize the source on every execution, not just at the route boundary
- do not hardcode secrets

---

## Development workflow

Use the existing package scripts:

```bash
npm run dev        # dev server
npm run dev:demo   # dev server in AUTH_MODE=demo, Keycloak variables blanked
npm run build      # production build
npm run start      # run the production build
npm run lint       # biome check (lint + format, no writes)
npm run lint:fix   # biome check --write
npm run format     # biome format --write
npm run typecheck  # next typegen && tsc --noEmit
npm test           # node --test via tsx
npm run test:fuzz  # property-based SQL and PromQL guard suites alone (FUZZ_RUNS, FUZZ_SEED)
npm run test:integration # real-server suites against TimescaleDB (Testcontainers, or MIGRATE_TEST_DATABASE_URL)
npm run e2e        # Playwright journey + axe scans (e2e/; Docker; AI_PROVIDER=stub; realm sign-in)
npm run fixture:capture  # add a stored dashboard spec to the IR fixture library
npm run eval       # grade recorded generations (evals/); --live --record re-records
npm run config:check # validate the environment as the server does at startup (exit 1 = would not boot)
npm run migrate    # apply Postgres migrations (--check, --dry-run, --down)
npm run migrate:verify # round-trip every migration (scratch database)
npm run seed       # looping metrics seeder
npm run self-metrics # scrape the app's own /api/metrics into metrics.holotable_self
npm run smoke      # end-to-end check of the self-monitoring demo dashboard
```

Before finalizing code changes, run the checks relevant to your change:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build` for framework/build-sensitive changes

CI (`.github/workflows/ci.yml`) runs all four on every pull request as three
jobs — `Static checks` (lint, typecheck), `Test` (tests, `config:check` on
`.env.example`, the LLM eval replay) and `Build` — and those three are the
required checks on `main`. The same workflow also round-trips the migrations
and runs the real-database integration suites against one TimescaleDB
(`Database`), lints and renders the Helm chart, builds the Docker images and
runs the self-monitoring smoke test against exactly those images (`Images and
smoke`), runs the Playwright and axe `End-to-end and accessibility` suite, and
a long fuzz of the SQL guard; those report on every pull request but do not
gate the merge, so read them. Every Node job starts with the composite action
in `.github/actions/setup/` (Node 22, `npm ci`); a Node bump is one edit
there, and `test/workflow-pins.test.ts` holds its pins like a workflow's.
Five constraints CI enforces that are easy to break accidentally:

- `lint` is **Biome**, linter and formatter in one tool, configured entirely in
  `biome.json`. CI runs `biome ci`, which never writes, so an unformatted file
  fails the build. Run `npm run lint:fix` (safe fixes) or `npm run format`
  before finishing. There is no ESLint and no Prettier; do not add either.
- `typecheck` runs `next typegen` first on purpose. Next 16 writes the route
  helper types (`RouteContext`, `PageProps`, `LayoutProps`) into `.next/types`,
  which `tsconfig.json` includes; a bare `tsc --noEmit` on a cold checkout
  fails without them.
- `build` must succeed with **no** `.env` at all. Every value in
  `src/lib/config.ts` has a fallback. If a change makes the build require a
  secret, the change is wrong. Startup validation (`validateConfig` in
  `src/lib/config.ts`, run from `src/instrumentation.ts`) is a runtime concern
  and is skipped during the build phase on purpose.
- The `Helm chart` job renders `deploy/helm/holotable` with its defaults, with
  each example values file, and with every optional object enabled, and then
  asserts that two *bad* renders still fail: a credential under `.Values.config`
  (which would land in a ConfigMap in clear text) and a
  `terminationGracePeriodSeconds` below the drain budget (which would make the
  kubelet `SIGKILL` the server mid-drain). Those two guards are `fail` calls in
  the templates; if you change them, change the assertions with them.
- The server refuses to boot on an invalid configuration. When a change reads a
  new environment variable, add it to `EnvSchema`/`validateConfig` with a
  message that names the variable and what to do, keep a *missing* value a
  warning in development and an error in production, and cover it in
  `test/config.test.ts`. `npm run config:check` must still exit 0 on
  `.env.example` in development mode; CI checks that.

Four Biome rules are errors deliberately: `noFloatingPromises`,
`useExhaustiveDependencies`, `noExplicitAny` (which matches the TypeScript rule
below), and `noConsole`, which now allows nothing in `src/` — write through
`log` from `src/lib/log.ts` instead. `scripts/` and `test/` are exempt, since a
CLI's output is its interface. Fix violations rather than suppressing them. A deliberate
fire-and-forget promise is marked with the `void` operator — that is the
sanctioned opt-out and it makes the intent visible at the call site; a bare
`// biome-ignore` needs a reason and should be rare.

If changing database-related code, also consider whether `migrate` or `seed`
behavior is impacted.

A new migration in `migrations/` must declare its down path in the file —
either a `-- rollback:` section whose remainder undoes it, or an
`-- irreversible: <reason>` line. `loadMigrations` in
`scripts/lib/migrations.ts` throws on a migration that declares neither, so
every mode including `--check` fails until it is written. The `Migrations` CI
job rolls each reversible migration back against a TimescaleDB service
container and asserts the schema fingerprint matches the previous step, so an
incomplete down path fails CI. Prefer expand/contract over an in-place change
to an existing column: during a rolling update both versions of the code run at
once. `docs/src/content/docs/operations/migrations.md` has both.

A change that alters something the docs describe updates the page in the same
pull request. `CONTRIBUTING.md` has the checklist of which source file maps to
which page. `test/docs-drift.test.ts` holds the API routes, audit actions and
settings sections tables to the code, and the Docs workflow fails on a broken
link in the site or in the root markdown files.

Dependency updates arrive from Dependabot (`.github/dependabot.yml`), grouped
minor and patch updates weekly and each major on its own. They are reviewed and
merged by a person like any other pull request; nothing auto-merges. A `next`
or `react` major is a framework migration, not a version bump. Every action
in `.github/workflows/` is pinned to a full commit SHA with its version as a
trailing `# vX.Y.Z` comment, never a tag; `test/workflow-pins.test.ts` fails on
an unpinned `uses:`. Node 25 and later
(the `node` base images and `@types/node`) are ignored in `dependabot.yml`, so
only the LTS line up to 24 is proposed; a Node major is taken in one pull
request that moves both Dockerfiles, CI's `node-version` and `@types/node`
together. TypeScript 7 and later are ignored for the app until Next supports
them: 7 drops the JavaScript compiler API that `next build` and `next typegen`
load.

`CONTRIBUTING.md` says the same things for human contributors, including the
branch and Conventional Commit conventions and the pull request template's
invariants checklist. Keep the two in step.

---

## Coding standards

### TypeScript

- Maintain `strict` TypeScript compatibility.
- Prefer explicit types at module boundaries.
- Infer types from Zod schemas where possible.
- Avoid `any` unless absolutely necessary and narrowly scoped.

### React / Next.js

- Default to Server Components unless client behavior is required.
- Keep client components focused on interaction and presentation.
- Use Next navigation/routing patterns already established in the repo.
- Do not introduce legacy Pages Router conventions.

### Validation and parsing

- Validate untrusted inputs at boundaries.
- Prefer shared schema-based validation over hand-rolled checks.
- Fail clearly when invariants are violated.

### Utilities

- Reuse existing helpers before creating new abstractions.
- Keep helpers focused and side-effect-light.

---

## What to avoid

Do **not**:

- assume old Next.js behavior without checking current repo patterns
- duplicate the IR in separate TypeScript-only interfaces
- embed secrets or connection strings in dashboard specs
- let the client become the authority for protected query execution
- weaken SQL safety checks
- add broad dependencies when existing utilities/components are sufficient
- introduce large architectural rewrites unless explicitly requested

---

## Preferred change style

When implementing changes:

1. Understand the relevant schema, route, and UI flow first.
2. Make the smallest change that preserves architectural invariants.
3. Reuse existing patterns and primitives.
4. Keep server/client boundaries deliberate.
5. Verify with lint/tests/build as appropriate.

---

## If you are unsure

If a requested change appears to conflict with the architecture, prefer:

- preserving the IR contract
- preserving SQL safety
- preserving server authority over time/query execution
- preserving secret isolation
- preserving existing Next.js 16 patterns

Consult:

- the docs site under `docs/src/content/docs/`, which is the canonical
  explanation of every feature (`README.md` is only a landing page)
- `CONTRIBUTING.md`
- `SECURITY.md` — the same boundaries stated as a trust model
- `docs/src/content/docs/architecture/invariants.md`
- `docs/src/content/docs/operations/keycloak.md`
- `src/lib/ir.ts`

before making invasive changes.
