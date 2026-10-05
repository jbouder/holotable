# Contributing to Holotable

Thanks for taking an interest. Holotable is a small project maintained by one
person, so the fastest path from idea to merge is a short conversation before a
long diff.

- **Bug?** Open a [bug report](https://github.com/jbouder/holotable/issues/new?template=bug_report.yml).
- **Idea?** Open a [feature request](https://github.com/jbouder/holotable/issues/new?template=feature_request.yml)
  before writing the code, especially for anything that touches the shared IR,
  the SQL guard, or authorization.
- **Security issue?** Do not open an issue. Follow [SECURITY.md](SECURITY.md).

Be decent to the people you are talking to. There is no formal code of conduct
yet because there is no private inbox to report a violation to, and a policy
with no working reporting channel is worse than none. Until there is one, raise
a problem with [@jbouder](https://github.com/jbouder) directly.

## Local setup

Either path works. Docker is the shorter one.

### The shortest loop: demo mode

No Keycloak, just Node 22+ and Docker:

```bash
npm install
cp .env.example .env               # the first lines are all this loop needs
docker compose up -d postgres seed # TimescaleDB, migrations, demo data
npm run dev:demo                   # http://localhost:3000, demo sign-in
```

`npm run dev:demo` runs `next dev` with `AUTH_MODE=demo` and the Keycloak
variables blanked. It is right for dashboards, panels, charts and the SQL
guard. It is not for auth work; see the note on authentication below.

### Docker

```bash
cp .env.example .env
# set a strong SESSION_SECRET and your AI_PROVIDER/AI_MODEL (+ keys)
docker compose up --build          # timescaledb, keycloak, migrate, app, seed
```

Open <http://localhost:3000>. The `seed` service continuously inserts demo
metrics and, once, creates the `demo` workspace's sources and dashboards, so a
fresh checkout has live data to look at.

### Local

Requirements: Node 22+ and a TimescaleDB instance.

```bash
npm install
cp .env.example .env               # edit DATABASE_URL, TIMESCALEDB_URL, secrets, AI_*
psql "$DATABASE_URL" -f timescaledb/init/001_schema.sql
npm run migrate                    # apply Postgres migrations
npm run seed                       # looping metrics seeder (+ demo source/dashboard)
npm run self-metrics               # optional: scrape the app's own /api/metrics
npm run dev                        # http://localhost:3000
```

`npm run self-metrics` is the self-monitoring demo (#54): it lands the app's own
`/api/metrics` in `metrics.holotable_self`, which the seeder registers as a
source, so the **Holotable self-monitoring** dashboard reads guarded SQL over
real data the app produced. It needs `METRICS_TOKEN` set to the same value the
app has, or the scrape is refused with a 404. Under `docker compose` it runs on
its own and the token has a local default;
`docker compose --profile smoke run --rm smoke` then checks the whole path end
to end.

Authentication is OIDC-only for real users — there is no local or dev login
path — so you need the Keycloak from `docker compose` (or your own realm) when
running the app with `npm run dev`. See
[Keycloak setup](docs/src/content/docs/operations/keycloak.md) for the
group-mapper configuration that produces the roles the app authorizes against.
Scripts and pipelines that are not a person use a service-account API token
from **Settings → API tokens** instead (#288); it holds one workspace at viewer
or editor and is checked by the same `can()`.

The one exception is `AUTH_MODE=demo`, which gives every visitor a session with
no login, for evaluating Holotable and for the public demo. It refuses to boot
beside any `OIDC_*` variable or with `DEMO_GROUPS` above editor. It is fine for
working on dashboards, panels and charts. It is **not** for working on
authentication or authorization: anything under `src/lib/auth/`, the session or
the claims is tested against the realm. See
[Demo mode](docs/src/content/docs/operations/demo-mode.md).

The documentation site is a separate Astro project with its own
`package.json`:

```bash
cd docs && npm install && npm run dev
```

## Checks

Run these before you push. CI runs the same four on every pull request, plus a
Docker image build and a Helm lint/template pass, and they are required to
merge.

```bash
npm run lint         # biome check (lint + format, no writes)
npm run typecheck    # next typegen && tsc --noEmit
npm test             # node --test (IR, auth, SQL safety, poller, layout, chat)
npm run build        # production build
```

`npm run config:check` validates your `.env` the way the server does at startup
and exits 1 on anything that would refuse to boot; `NODE_ENV=production` applies
the production rules. Missing values are warnings in development and errors in
production, so `.env.example` always starts the dev server. The rules and how to
add one are in `docs/src/content/docs/operations/startup-validation.md`.

If you touch `deploy/`, render the chart before you push — the CI job does the
same, plus every example values file:

```bash
helm lint deploy/helm/holotable
helm template holotable deploy/helm/holotable > /dev/null
```

`npm run test:integration` runs the suites that need a real database:
read-only execution, statement timeouts, the allowlist end to end, repository
round trips, a poller ticking over real rows, and the real-server halves of
the audit, row-filter, pool, annotation, share and token suites. It starts
TimescaleDB with Testcontainers, initialized by `timescaledb/init`, so it needs
Docker; without it the run is skipped with a message (and fails under `CI`).
`MIGRATE_TEST_DATABASE_URL` points it at an existing scratch database instead.
In `npm test` those tests skip themselves.

`npm run e2e` runs the Playwright suite in `e2e/`: the core journey (register
a source, generate, save, watch rows arrive over SSE, pause, resume, edit,
save a version), Explore, chat, a tombstoned source, a viewer kept out of the
editor, and axe accessibility scans of every main surface in both themes. It
brings up `e2e/compose.yml` (TimescaleDB and Keycloak on ports 55433 and 18181,
away from your dev stack), builds the app and starts it on 3107, and signs in
through the dev realm as `demo` and `viewer` — there is no test-only login. The
model is `AI_PROVIDER=stub`, which answers with recorded specs. Needs Docker;
`E2E_SKIP_BUILD=1` reuses the last build, `npm run e2e:down` removes the
stack. A failure leaves a trace and a screenshot under `e2e/test-results/`.
See [Accessibility](docs/src/content/docs/architecture/accessibility.md) for
what the scans gate on.

A change to the IR is checked against `test/fixtures/specs/`, stored specs
that are never edited; see the README there before adding one or changing a
snapshot under `test/snapshots/`.

`npm run test:fuzz` runs the property-based SQL guard suite on its own.
`npm test` includes it with a fixed seed and a small iteration count, so it is
deterministic; CI also runs it longer with a fresh seed in a job that is not
required to merge. If it fails, the output has the exact statement and a
`FUZZ_SEED=… FUZZ_PATH=…` line that replays that one case. Add the statement to
`test/fixtures/sql-fuzz-corpus.ts` with the verdict it should have, and a named
test explaining why.

Three notes on the less obvious ones:

- `npm run lint` is [Biome](https://biomejs.dev) — linter *and* formatter in one
  tool, configured entirely in `biome.json`. `biome check` only reports;
  `npm run lint:fix` applies the safe fixes and `npm run format` reformats.
  Unformatted code fails CI, so run one of those before pushing. There are no
  git hooks: install the [Biome editor extension](https://biomejs.dev/guides/editors/first-party-extensions/)
  and format on save instead.
- `npm run typecheck` starts with `next typegen` deliberately. Next 16 writes
  the route helper types into `.next/types`, and a bare `tsc --noEmit` on a cold
  checkout fails without them.
- `npm run build` must succeed with **no** `.env` at all. Every value in
  `src/lib/config.ts` has a fallback; if the build starts needing a secret, that
  is a bug in the change, not in CI.

Four lint rules are errors on purpose and are worth knowing before you hit them:
`noFloatingPromises` (mark a deliberate fire-and-forget with `void`, so the
intent is visible), `useExhaustiveDependencies`, `noExplicitAny`, and
`noConsole` (nothing is allowed in `src/` — write through `log` from
`src/lib/log.ts`; `scripts/` and `test/` are exempt). Fix a violation rather
than suppressing it; if a suppression is
genuinely right, use a scoped `// biome-ignore` with a reason on the line.

If you touch anything that moves (an overlay, a list, a theme or tab switch,
a panel's fullscreen), check it by hand as well: there is no browser test
harness, and sign-in goes through Keycloak, so the one test that would prove
the gating (`document.getAnimations()` empty under Reduce, non-empty under
Allow) cannot run in CI. That is a deliberate decision, revisited only if an
end-to-end harness is wanted for more than motion. The checklist, in Chromium
and Safari, under Settings → Appearance → Motion set to *Reduce*, then *Allow*,
then *Follow system* with the OS reduce-motion setting toggled both ways:

- open and close a dialog, a card's `⋯` menu, the time-range popover and a
  select;
- switch the theme from the account menu;
- flip Editor/Preview in the editor;
- reorder and delete a panel in the editor's list;
- expand and collapse a panel;
- navigate between two pages.

Under *Reduce* nothing moves and every overlay still opens, closes and
unmounts. Under *Allow* everything above animates, whatever the OS says.
The unit tests cover the rest: `npm test` pins the helpers' fallbacks, the
overlay primitives' enter/exit classes, and the rules themselves (no
`motion-safe:`, no literal durations, no animation library).

If you touch database code, consider whether `npm run migrate` or `npm run seed`
behavior changes too. Migrations should be additive and safe to apply to an
existing database.

A new migration must declare its down path in the file: a `-- rollback:`
section holding the statements that undo it, or an `-- irreversible: <reason>`
line saying why there is none. The runner refuses to load a migration that
declares neither, so this fails locally, not in review. The `Migrations` CI job
then rolls every reversible migration back against a real TimescaleDB and
checks the schema lands on exactly what the previous migration left — a down
path that forgets to drop one table fails there. For a change the old code
cannot tolerate, use expand/contract; both are documented in
[Database migrations](docs/src/content/docs/operations/migrations.md).

## Invariants a pull request must not break

This is the part that matters most, and the part a reviewer will push back on.
Holotable lets a language model author SQL that the server then executes against
a live database. The safety of that arrangement rests on a specific set of
guarantees, each with a named enforcement point.

Read [Invariants](docs/src/content/docs/architecture/invariants.md) in full
before changing generation, execution, or authorization. [SECURITY.md](SECURITY.md)
describes the same boundaries from the trust side, and
[AGENTS.md](AGENTS.md) — written for coding agents but accurate for humans —
covers the repository conventions in more detail than this file does.

The short version, five rules:

1. **The shared IR is the contract.** `src/lib/ir.ts` is the single Zod schema
   used by model output, API validation, persistence, and the client. If
   dashboard or panel structure changes, change the schema first and let types
   be inferred from it. Do not introduce a parallel TypeScript-only interface
   that can drift. A change that would stop a saved spec parsing bumps
   `SPEC_VERSION` and adds an upgrader to `src/lib/ir/upgrade.ts` (see
   AGENTS.md); the fixture library in `test/fixtures/specs/` fails until it
   does. Panel kinds are registered in `src/lib/panels/registry.ts`,
   not listed in `ir.ts`; the docs page "Streaming and rendering" says how to
   add one.
2. **The model generates specs, never data.** The LLM may produce a
   specification and SQL. It must never produce metric values, and the client
   must never render data that did not come from server-side query execution.
3. **All model SQL is untrusted.** SELECT-only, catalog allowlist, no comments,
   no non-deterministic or time functions, read-only execution settings, row and
   time limits. `src/lib/sql/safety.ts` is the chokepoint. Never weaken a check
   for convenience; if a legitimate query is blocked, widen the allowlist
   deliberately and add a test.
4. **The server owns time.** The IR may carry a relative expression like
   `now-15m`, but resolving it to a concrete range and injecting the filter
   bound to the panel's `timeField` happens on the server (`src/lib/time.ts`).
   Neither the client nor the model may supply an authoritative time window.
5. **No secrets in specs.** A panel references a source by stable `sourceId`
   only. The registry owns the connection config and a `secret_ref`;
   credentials resolve from the environment at execution time and are never
   stored in a dashboard spec, a panel config, or any client-visible payload.

A change that genuinely needs to move one of these lines is welcome — open an
issue and make the case first, rather than arriving with it already written.

## Pull requests

- **Branch** from `main`, named `type/short-description`
  (`docs/community-files`, `fix/poller-leak`, `feat/heatmap-panel`).
- **Commit messages** follow [Conventional Commits](https://www.conventionalcommits.org/):
  `feat:`, `fix:`, `docs:`, `ci:`, `chore:`, `refactor:`, `test:`. Write the
  subject in the imperative and keep it under ~72 characters. The body is where
  the reasoning goes — *why*, not *what*; the diff already says what.
- **Keep it focused.** One concern per pull request. An unrelated formatting
  sweep mixed into a behavior change makes both harder to review.
- **Fill in the template**, including the invariants checklist. If a box does
  not apply, say so rather than deleting the line.
- **Tests.** `test/` uses the native Node test runner via `tsx`. Anything
  touching the SQL guard, the IR schema, authorization, time resolution, or the
  poller should come with a test; those are the areas where a silent regression
  is most expensive.
- **Component tests** are the exception to "pure logic only", and live in
  `*.test.tsx` beside the rest. `test/support/dom.tsx` mounts a component in
  jsdom (a devDependency; it never reaches the build) and flushes with `act`.
  Reach for it only when a behaviour genuinely cannot be tested without a
  render — an error boundary, for instance, since `react-dom/server` does not
  run boundaries at all. Everything else still belongs in `src/lib/` as a
  function with a plain test.
- **Draft PRs** are fine and encouraged for work you want early eyes on.

Files under `src/lib/sql/`, `src/lib/auth/`, `src/lib/ir.ts`, `src/lib/ir/`,
and `src/lib/metrics-access.ts` have a code owner and will always be reviewed
before merge.

## Style

Match the surrounding code rather than importing conventions from elsewhere.

- Strict TypeScript. Infer types from Zod where a schema already exists. Avoid
  `any`; where it is genuinely unavoidable, scope it narrowly.
- Server Components by default. Reach for `"use client"` only when hooks,
  browser APIs, or interactivity require it.
- Tailwind v4 utilities and the existing design tokens in
  `src/app/globals.css`. Reuse the primitives in `src/components/ui/` before
  adding new ones, and `cn()` from `src/lib/utils.ts` for composition.
- Domain logic belongs in `src/lib/`, not inside page components.
- Motion is platform-only (View Transitions, WAAPI, `@starting-style`, FLIP)
  and keys off `<html data-motion>`, never the OS media query directly.
  Durations and curves come from the tokens in `globals.css`; the full rules
  are the "Motion rules" section of `AGENTS.md`.
- This is Next.js 16 and React 19. Check the installed docs in
  `node_modules/next/dist/docs/` or the existing repository patterns before
  relying on behavior you remember from an older version, and do not introduce
  Pages Router conventions.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers the project.
