# AGENTS.md

Holotable is a natural-language dashboard builder for monitoring data. People
describe a dashboard; a model writes a **validated spec** (never the data);
the server runs the spec's guarded queries against TimescaleDB/PostgreSQL or
Prometheus and streams the results.

This file is the rules a change has to follow. What each feature does and why
is on the docs site (`docs/src/content/docs/`), which is canonical;
`CONTRIBUTING.md` is the human-facing version of this file, so keep the two in
step. Many rules below are held by a test named beside them: when one fails,
it is telling you the rule.

## Invariants

- **The model generates specs, never data.** No flow where a model returns
  metric values, the browser trusts model-produced points, or a chart skips
  server-side execution.
- **The Zod IR (`src/lib/ir.ts`) is the one contract** between generation,
  APIs, persistence and rendering. Types are inferred from it; never add a
  parallel TypeScript shape.
- **Every query is untrusted**, whoever wrote it: SELECT-only, read-only,
  allowlisted, row- and time-bounded, through the SQL guard
  (`src/lib/sql/safety.ts`) or the PromQL guard (`src/lib/promql/safety.ts`).
  Never weaken a guard for convenience.
- **The server owns time.** The IR carries expressions like `now-15m`; only
  the server resolves and enforces windows.
- **Sources are opaque ids.** No connection detail, credential or secret in a
  spec, a panel or anything sent to the browser.
- **Authorization is `can()`** (`src/lib/auth/authorize.ts`), from the
  validated token's `groups` claim (or a service-account token's one role).
  Never from a workspace id in a request; re-authorize the source on every
  execution, not only at the route.

## Next.js 16 and React 19

Exact versions are in `package.json`. Do not assume older Next or React
behavior: read the installed guides in `node_modules/next/dist/docs/` and
follow the patterns already in the repository, especially for Server/Client
Component boundaries, route handlers, streaming and config. App Router only;
`"use client"` only where hooks, browser APIs or interaction need it.

## Where things are

- `src/app/` routes and pages; `src/components/` UI, with primitives in
  `src/components/ui/` (reuse before adding); `src/lib/` domain logic (keep
  it out of pages, and test it there as functions).
- `test/` the Node test runner (`*.test.ts`; `*.test.tsx` only for the rare
  test that needs a real React unwind, through `test/support/dom.tsx`).
  `e2e/` Playwright journeys and axe scans against their own stack. A
  surface a journey drives is proved there, not mounted again under jsdom,
  which cannot open a Base UI popup and races a stubbed `fetch` (#511).
- `docs/` the Astro site (its own `package.json`). `deploy/` the Helm chart,
  the quick-start image and the hosted demo (its own `package.json`, checked
  by `.github/workflows/demo.yml`).
- `.claude/skills/holotable/` the `/holotable` skill.
  `test/holotable-skill.test.ts` holds its lists of panel kinds, formats and
  color tokens to the code, so a change to those updates its `references/`.

## Extension points: register, never branch

Three registries own their kinds. Add a kind by registering it; never
`switch` on, or compare, a kind outside its registry.

- **Panel kinds**: `src/lib/panels/registry.ts`, one module per kind under
  `kinds/`. Its renderer is one line in `src/components/panels/registry.ts`
  and its click mapping one in `src/lib/drilldown-datum.ts`; neither
  compiles without them. `panel.query` is optional (a text panel runs none):
  filter with `hasQuery`. Read a panel's window and cadence through
  `panelTimeRange` / `panelRefreshMs`.
- **Source kinds**: `src/lib/sources/registry.ts` (browser half under
  `kinds/`, server half under `server/`). Ask `sourceKind()` /
  `serverKind()`; never import `src/lib/timescaledb/` from a route. Read a
  query through `isSqlQuery` / `queryText` / `queryTimeField`, not its
  fields. Held by `test/source-kinds.test.ts` and
  `test/query-language.test.ts`.
- **Model provider kinds**: `src/lib/ai/providers/registry.ts`. Ask
  `kindOf()` / `serverProviderKind()`; never compare `provider` or import an
  `@ai-sdk/*` package outside `src/lib/ai/providers/`. A server half passes
  its credentials and the vendor's URL to the SDK explicitly, through the
  fetch the registry picks. Held by `test/provider-kinds.test.ts`.

The same idea elsewhere: `/settings` sections are data in
`src/lib/settings.ts` (a gated section's page also calls `notFound()`), and
audit actions are `AUDIT_ACTIONS` in `src/lib/audit.ts`, each held to the
route that emits it by `test/audit.test.ts`. A new mutating route records an
audit event.

## Changing the IR

An additive, optional field needs nothing special. A change that would make a
stored spec fail to parse (a renamed, removed or newly required field, a
dropped kind) is breaking:

- bump `SPEC_VERSION` and append an upgrader to `UPGRADERS` in
  `src/lib/ir/upgrade.ts` (pure, on plain JSON, importing nothing from
  `ir.ts`);
- add fixtures of the new version beside the old ones in
  `test/fixtures/specs/` (never edit one; `npm run fixture:capture` reads one
  from a live dashboard), and rewrite the snapshots with
  `UPDATE_SNAPSHOTS=1 npm test`;
- read any spec you did not just build through `StoredDashboard`, never
  `Dashboard`;
- check SQL that reads raw `spec` jsonb (`VERSION_COLUMNS` in
  `src/lib/db/repo.ts`, the source-impact queries), which assumes a
  top-level `panels` array.

## Security-sensitive code

The paths in `.github/CODEOWNERS` (the SQL and PromQL guards, `auth/`,
`secrets/`, the IR, time, row scope, variables, the base-URL guard,
`metrics-access.ts`) are where a quiet regression is a vulnerability. A
change there needs a test.

- **Guards.** Run `npm run test:fuzz` after any SQL or PromQL guard change.
  Promote a counterexample into `test/fixtures/sql-fuzz-corpus.ts` (or
  `promql-corpus.ts`) and a named test; never bend the generator around it.
- **Query rewrites.** Row filters and variables work on the parse tree,
  never a regex, and every rewrite is re-parsed and verified.
  `buildExecutablePlan` takes `rowFilter` as a required input, bound with
  `rowFilterFor` / `rowFilterInScope`. A variable's value is always a bound
  parameter, never text.
- **Model calls.** A generation route calls `requireModel(...)` before the
  limits; every `streamObject` / `streamText` spreads
  `...modelSettings(model)` and sets no `onError` of its own
  (`test/ai-invoke.test.ts`). A new generation surface uses
  `useRepairingObject`, not `useObject`.
- **Untrusted URLs.** A typed model or source URL is fetched only through
  the guarded fetch (`src/lib/ai/base-url.ts`, `src/lib/ai/guarded-fetch.ts`),
  checked at DNS time, with a byte cap on the reply.
- **Secrets and logs.** Credentials are sealed (`src/lib/secrets/seal.ts`),
  never returned, and registered with `rememberSecret` when opened. Write
  through `log` (`src/lib/log.ts`), never `console`; a log line never carries
  a credential, and SQL and prompts are reduced to digests.
- **Credentials that are not people.** Share links (`hts_`) are accepted
  only by the stream route and `src/app/embed/` (`test/share.test.ts`); MCP
  access tokens only by `/api/mcp` (`test/mcp-auth.test.ts`);
  service-account tokens (`ht_`) are one workspace at viewer or editor,
  never more. `Identity.displayName` and `email` never feed an authorization
  decision.
- **The browser sends ids, not statements.** Explore and chat send the
  question; a stored panel reruns from its stored spec; a stored message
  never holds result rows. A schema repair sends only `{ repairOf: id }`,
  the rest comes from the server. A drilldown link names a dashboard by id,
  resolved and re-checked on the server; the browser builds hrefs only to
  those.
- **Workspace scope.** Annotations, prompt context and every other
  workspace-owned row are read and written with the workspace from the
  record or the path, and every statement filters on it. An example query in
  a workspace's prompt context passes the guard before it is saved and again
  before the model sees it.
- **Closed by default.** `/api/metrics` answers nothing until `METRICS_TOKEN`
  or `METRICS_ALLOWED_CIDRS` is set. The realm's refresh token stays sealed
  on the server; the browser holds only an opaque id scoped to `/api/auth`.
- **CSP.** An inline `<script>` or `<style>` needs the nonce from
  `src/proxy.ts`. Custom visuals (Vega) evaluate through `vega-interpreter`,
  never `new Function`; only the modules listed in
  `test/vega-runtime.test.ts` import Vega.

## Auth

Keycloak OIDC is the only way a real person signs in. `src/app/api/auth/` has
exactly five routes (`login`, `callback`, `logout`, `refresh`,
`backchannel-logout`). Never add a development-only path or a seeded user;
make the local Keycloak work instead.

`AUTH_MODE=demo` is the one exception, for evaluation and the public demo: it
changes *minting*, never *verification*, and its guards in `validateConfig`
(no `OIDC_*`, no group above editor) stay boot errors. It is not a way to
develop auth code: anything touching `src/lib/auth/`, sessions or claims runs
against the realm.

## UI and UX

Consistent, high-quality UI is a requirement, not polish: a change that works
but looks, moves or reads differently from the rest of the app is not done.
Before building UI, look at how the nearest existing surface does the same
thing and match it.

### Styling and components

- Tailwind v4 utilities and the tokens in `src/app/globals.css` (surfaces,
  borders, muted text, the primary accent), composed with `cn()` from
  `src/lib/utils.ts`. No literal colors, no one-off spacing scales, no new
  fonts. Check every change in **both** themes.
- Use the primitives in `src/components/ui/` before writing markup:
  `Button` / `ButtonLink`, `Input`, `Select`, `Autocomplete`, `Checkbox`,
  `Menu`, `Popover`, `Dialog`, `ConfirmDialog`, `Card`, `Table`, `Badge`,
  `PageHeader`, `EmptyState`, `Skeleton`, `ErrorDisplay`. A new kind of
  control becomes a primitive there, built on Base UI and styled like its
  neighbors, not a one-off in a feature.
- Never a native browser widget where the app has a primitive: no
  `<select>`, `<datalist>`, `window.confirm`/`alert`, or browser-drawn date
  pickers. The browser draws those in its own style, different in each
  browser and outside the theme.
- Every page renders `PageHeader` (title, one sentence on what the page is
  for, the page's actions) in every state, and has a deliberate empty state
  (`EmptyState`), loading state (`Skeleton`, shaped like what is coming) and
  error state (`ErrorDisplay`). A destructive action asks through
  `ConfirmDialog` and names what it removes.
- Layouts work from phone width up with no sideways scroll; full-width pages
  use the full width, and text stays at a readable measure.
- Keep presentation separate from domain logic: logic in `src/lib/`, tested
  as functions; components small and composable.

### Accessibility

Checked, not hoped for:

- Every text/background token pairing meets WCAG AA in both themes;
  `test/contrast.test.ts` measures them (`src/lib/color/contrast.ts`) and
  the table in `docs/src/content/docs/architecture/accessibility.md`. A new
  pairing goes in `CONTRAST_PAIRS`.
- A chart goes through `AccessibleChart`; a link styled as a button is
  `ButtonLink` (never `<Link><Button>`); an icon-only control has an
  `aria-label`; every input has a label; focus is visible and keyboard order
  follows the page.
- `npm run e2e` scans every main surface with axe in both themes; a new page,
  dialog or menu adds itself to `e2e/a11y.spec.ts`.

### Charts

ECharts, through the existing chart components. Charts merge new data and are
never recreated (FLIP a panel's card, never its chart). Design tokens are
authored in OKLCH and are converted before they reach ECharts, so chart
colors come from the token system too: series from `chartPalette()`, and
axis text, lines and grid from `ctx.theme` (`useChartTheme`, read off the
page), never a literal that suits one theme (`test/chart-theme.test.ts`).

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

## Checks

Before finishing: `npm run lint`, `npm run typecheck`, `npm test`, and
`npm run build` for anything framework- or build-sensitive. Those are CI's
required checks. CI also runs migrations, integration, Helm, images and
smoke, end-to-end and a long fuzz; they do not gate the merge, but they are
expected to pass. The other scripts, and when to reach for them:

```bash
npm run dev:demo         # dev server in AUTH_MODE=demo, no Keycloak needed (not for auth work)
npm run test:fuzz        # after any SQL or PromQL guard change (FUZZ_RUNS, FUZZ_SEED)
npm run test:integration # after a change to queries, repos or migrations (Docker, or MIGRATE_TEST_DATABASE_URL)
npm run e2e              # after a UI or auth change: Playwright journeys and axe scans (Docker)
npm run migrate:verify   # after adding a migration: round-trips every one on a scratch database
npm run config:check     # after adding an environment variable
npm run eval             # after a prompt change: grades recorded generations (--live --record re-records)
npm run fixture:capture  # adds a stored spec to the IR fixture library
npm run smoke            # checks both self-monitoring dashboards end to end
```

- **Tests hold rules, not coverage.** A unit test exists because a rule
  above would otherwise regress silently: a guard, an authorization
  decision, the IR, time, a registry, a parser of untrusted input. Do not
  add one for a label or a formatter, a happy path an `e2e/` journey walks,
  a seeded dashboard `npm run smoke` already runs, or a shape the typechecker
  holds. Extend the named test that holds the rule before adding a file, and
  a change that only moves or restyles UI needs no new unit test.
- **Biome** is the linter and formatter (`npm run lint:fix`); there is no
  ESLint or Prettier. `noFloatingPromises`, `useExhaustiveDependencies`,
  `noExplicitAny` and `noConsole` are errors: fix them rather than suppress.
  A deliberate fire-and-forget is `void promise`.
- **Typecheck** runs `next typegen` first; a bare `tsc` fails on a cold
  checkout.
- **Build with no `.env`.** Every config value has a fallback. A new
  environment variable goes in `EnvSchema` / `validateConfig` with a message
  naming it, warns in development and errors in production, and is covered
  in `test/config.test.ts`; `npm run config:check` must still pass on
  `.env.example`.
- **Migrations** declare their down path (`-- rollback:` or
  `-- irreversible: <reason>`) and prefer expand/contract, since old and new
  code run together during a rollout. CI rolls each one back and compares
  schema fingerprints.
- **Helm**: the chart's two `fail` guards (a credential under
  `.Values.config`, a grace period below the drain budget) have assertions in
  CI; change them together.
- **Docs**: a change to something the docs describe updates the page in the
  same pull request (`CONTRIBUTING.md` maps source files to pages).
  `test/docs-drift.test.ts` holds the API routes, audit actions and settings
  tables to the code.
- **Actions** are pinned to a full commit SHA with a `# vX.Y.Z` comment
  (`test/workflow-pins.test.ts`). Dependabot's ignores (Node 25+,
  TypeScript 7+) are explained in `.github/dependabot.yml`.
