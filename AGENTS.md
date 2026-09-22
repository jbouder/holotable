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
- `scripts/` — migration and seeding scripts
- `test/` — Node test runner tests (`*.test.ts`; `*.test.tsx` for the few that
  need a real render, via the jsdom harness in `test/support/dom.tsx`)
- `docs/` — the Astro + Starlight documentation site (its own `package.json`;
  content under `docs/src/content/docs/`)
- `timescaledb/` — database bootstrap/schema assets
- `.github/` — CI workflows, issue forms, the pull request template, `CODEOWNERS`

Important files:

- `src/lib/ir.ts` — the canonical shared dashboard IR schema
- `src/lib/sql/safety.ts` — the SQL guard every generated query passes through
- `src/lib/sql/ast.ts` — the PostgreSQL parse-tree walk the guard is built on
- `src/lib/auth/authorize.ts` — the central `can()` check
- `src/lib/time.ts` — server-side time expression/range resolution
- `src/lib/registry.ts` — source registry: safe connection config and
  `secret_ref` resolution
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
- `src/app/globals.css` — design tokens and Tailwind v4 theme setup
- `next.config.ts` — standalone output, `pg` externalization
- `package.json` — authoritative scripts/tooling
- `SECURITY.md` — the trust model and the disclosure process
- `CONTRIBUTING.md` — the human-facing version of this file

The six paths with a `CODEOWNERS` entry (`src/lib/sql/`, `src/lib/auth/`,
`ir.ts`, `time.ts`, `registry.ts`, `metrics-access.ts`) are the ones where a
quiet regression stops being a bug and becomes a vulnerability. Changes there
need a test.

For `src/lib/sql/` that test is often already written for you:
`test/sql-safety.fuzz.test.ts` generates statements from adversarial shapes and
checks that poisoned ones are rejected, benign ones accepted, and accepted ones
satisfy an independent parse-tree oracle. Run `npm run test:fuzz` after any
guard change; a failure prints the statement and a replay line. Promote the
counterexample into `test/fixtures/sql-fuzz-corpus.ts` and a named test rather
than adjusting the generator to avoid it.

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

Keycloak OIDC is the **only** way to authenticate. There is no local login, no
dev-login bypass, and no seeded user — `src/app/api/auth/` has exactly three
routes (`login`, `callback`, `logout`), and running the app locally still needs
a realm. Do not add a development-only authentication path; make the local
Keycloak work instead.

Authorization is derived exclusively from the validated identity token's
`groups` claim and is centralized in `can()` (`src/lib/auth/authorize.ts`).
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
npm run build      # production build
npm run start      # run the production build
npm run lint       # biome check (lint + format, no writes)
npm run lint:fix   # biome check --write
npm run format     # biome format --write
npm run typecheck  # next typegen && tsc --noEmit
npm test           # node --test via tsx
npm run test:fuzz  # property-based SQL guard suite alone (FUZZ_RUNS, FUZZ_SEED)
npm run config:check # validate the environment as the server does at startup (exit 1 = would not boot)
npm run migrate    # apply Postgres migrations
npm run seed       # looping metrics seeder
```

Before finalizing code changes, run the checks relevant to your change:

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build` for framework/build-sensitive changes

CI (`.github/workflows/ci.yml`) runs all four on every pull request, plus a
Docker image build, and they are required to merge. Three constraints they
enforce that are easy to break accidentally:

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

- `README.md`
- `CONTRIBUTING.md`
- `SECURITY.md` — the same boundaries stated as a trust model
- `docs/src/content/docs/architecture/invariants.md`
- `docs/src/content/docs/operations/keycloak.md`
- `src/lib/ir.ts`

before making invasive changes.
