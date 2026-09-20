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
npm run dev                        # http://localhost:3000
```

Authentication is OIDC-only — there is no local or dev login path — so you need
the Keycloak from `docker compose` (or your own realm) even when running the app
with `npm run dev`. See
[Keycloak setup](docs/src/content/docs/operations/keycloak.md) for the
group-mapper configuration that produces the roles the app authorizes against.

The documentation site is a separate Astro project with its own
`package.json`:

```bash
cd docs && npm install && npm run dev
```

## Checks

Run these before you push. CI runs the same four on every pull request, plus a
Docker image build, and they are required to merge.

```bash
npm run lint         # biome check (lint + format, no writes)
npm run typecheck    # next typegen && tsc --noEmit
npm test             # node --test (IR, auth, SQL safety, poller, layout, chat)
npm run build        # production build
```

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
`noConsole` (`console.warn` and `console.error` are allowed until structured
logging lands). Fix a violation rather than suppressing it; if a suppression is
genuinely right, use a scoped `// biome-ignore` with a reason on the line.

If you touch database code, consider whether `npm run migrate` or `npm run seed`
behavior changes too. Migrations should be additive and safe to apply to an
existing database.

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
   that can drift.
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
- **Draft PRs** are fine and encouraged for work you want early eyes on.

Files under `src/lib/sql/`, `src/lib/auth/`, and `src/lib/ir.ts` have a code
owner and will always be reviewed before merge.

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
- This is Next.js 16 and React 19. Check the installed docs in
  `node_modules/next/dist/docs/` or the existing repository patterns before
  relying on behavior you remember from an older version, and do not introduce
  Pages Router conventions.

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), the same license that covers the project.
