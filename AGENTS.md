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
- `test/` — Node test runner tests
- `docs/` — architecture and integration notes
- `timescaledb/` — database bootstrap/schema assets

Important files:

- `src/lib/ir.ts` — the canonical shared dashboard IR schema
- `src/lib/time.ts` — server-side time expression/range resolution
- `src/app/globals.css` — design tokens and Tailwind v4 theme setup
- `next.config.ts` — standalone output, `pg` externalization
- `package.json` — authoritative scripts/tooling

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

The README indicates Keycloak OIDC with group-based auth plus a local dev-login
path.

When touching auth:

- preserve secure defaults
- do not broaden access implicitly
- do not hardcode secrets
- keep dev-only auth paths clearly separated from production behavior

---

## Development workflow

Use the existing package scripts:

```bash
npm run dev
npm run build
npm run lint
npm run test
npm run migrate
npm run seed
```

Before finalizing code changes, run the checks relevant to your change:

- `npm run lint`
- `npm run test`
- `npm run build` for framework/build-sensitive changes

If changing database-related code, also consider whether `migrate` or `seed`
behavior is impacted.

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
- `docs/ARCHITECTURE.md`
- `docs/KEYCLOAK.md`
- `src/lib/ir.ts`

before making invasive changes.
