# Holotable

Natural-language monitoring dashboards. Describe what you want to see; a language
model authors a **validated visualization spec** (SQL + chart config) — never the
data itself — and Holotable executes the guarded SQL against TimescaleDB and
streams the results live.

- **Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · Base UI ·
  ECharts · TimescaleDB/PostgreSQL (config + metrics) · Vercel AI SDK
  (`streamObject` + `experimental_useObject`) · Keycloak OIDC (group-based auth) ·
  Server-Sent Events.
- **Contract:** one shared Zod IR (`src/lib/ir.ts`) is used by the LLM output,
  the API, persistence, and the client, so the spec cannot drift.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full invariant list and
the single-instance poller caveat, [`docs/PANEL_LIFECYCLE.md`](docs/PANEL_LIFECYCLE.md)
for how a panel is generated, stored, executed, and rendered end to end, and
[`docs/KEYCLOAK.md`](docs/KEYCLOAK.md) for the OIDC group-mapper setup.

## How it works

1. **Author** — `/api/generate` runs the LLM exactly once (only on create/edit).
   It streams a Dashboard IR spec that is validated with Zod.
2. **Save** — the whole immutable spec is stored as `jsonb`; every save appends a
   new `dashboard_versions` row.
3. **View** — a dashboard opens one `EventSource`. A single in-process poller per
   dashboard executes each panel's guarded SQL per tick and broadcasts deltas to
   all subscribers. The LLM never runs on view or on a tick.
4. **Render** — ECharts merges deltas into a bounded rolling window without
   recreating the chart.

All model SQL is untrusted: SELECT-only, catalog-table allowlist, no comments,
no time/non-deterministic functions, read-only settings, row/time limits, and a
**server-injected** time range bound to the panel's `timeField`. Panels carry
only a stable `sourceId`; the registry owns the safe connection config, the
catalog, and a `secret_ref`. Credentials are resolved from the environment at
execution time and never stored.

## Quick start (Docker)

```bash
cp .env.example .env
# set a strong SESSION_SECRET and your AI_PROVIDER/AI_MODEL (+ keys)
docker compose up --build          # timescaledb, keycloak, migrate, app, seed
```

The `seed` service continuously inserts demo metrics and (once) creates a demo
`demo` workspace source + dashboard. Open <http://localhost:3000>.

Development (source mount, hot reload, dev auth on):

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

## Quick start (local)

Requirements: Node 22+ and a TimescaleDB instance.

```bash
npm install
cp .env.example .env               # edit DATABASE_URL, TIMESCALEDB_URL, secrets, AI_*
psql "$DATABASE_URL" -f timescaledb/init/001_schema.sql
npm run migrate                    # apply Postgres migrations
npm run seed                       # looping metrics seeder (+ demo source/dashboard)
npm run dev                        # http://localhost:3000
```

Sign in locally without Keycloak (dev only, `DEV_AUTH_ENABLED=true`):

```bash
curl -c cookies.txt -X POST http://localhost:3000/api/auth/dev-login \
  -H 'content-type: application/json' \
  -d '{"sub":"dev","groups":["/workspaces/demo/source-admin","/platform-admins"]}'
```

Or use the in-app dev sign-in control (shown only when dev auth is enabled).

## Pages

| Path | Purpose | Min role |
| --- | --- | --- |
| `/dashboards` | List dashboards in a workspace | viewer |
| `/dashboards/new` | Prompt → preview → save | editor |
| `/dashboards/[id]` | Live viewer (SSE) | viewer |
| `/dashboards/[id]/edit` | Panel CRUD/layout, single-panel NL edits, version save | editor |
| `/explore` | Ad-hoc NL questions against editable sources; streams one panel spec, then runs it through guarded query preview | editor |
| `/data-sources` | Source CRUD / test / refresh | source-admin |

## API

| Route | Method | Notes |
| --- | --- | --- |
| `/api/generate` | POST | LLM streams a validated dashboard, panel, or explore-panel IR spec |
| `/api/query` | POST | One-shot guarded query (preview and Explore results) |
| `/api/dashboards` | GET/POST | List / create |
| `/api/dashboards/[id]` | GET/PUT/DELETE | Get / new version / delete |
| `/api/dashboards/[id]/stream` | GET | SSE deltas (cookie auth) |
| `/api/sources` | GET/POST | List / create |
| `/api/sources/[id]` | GET/PUT/DELETE | Get / update / delete (tombstone if referenced) |
| `/api/sources/[id]/test` | POST | Connectivity test |
| `/api/sources/[id]/refresh` | POST | Re-introspect catalog |
| `/api/auth/login` · `/callback` · `/logout` · `/dev-login` | | OIDC + dev session |

## Source secret references

A source stores a `secret_ref` (an uppercase env-var family), never credentials.
`resolveCredentials("TS_METRICS")` reads `TS_METRICS_USERNAME` /
`TS_METRICS_PASSWORD` from the environment at execution time. Point a
`secret_ref` at your **read-only** TimescaleDB role; the app never connects with a
privileged user. See `src/lib/registry.ts`.

## Configuration

All defaults are environment-configurable (`src/lib/config.ts`). Notable
documented defaults:

- **Refresh cadence:** `DEFAULT_REFRESH_INTERVAL_MS=15000` (15s), floored by
  `MIN_REFRESH_INTERVAL_MS=2000`.
- **Time range:** `DEFAULT_TIME_FROM=now-1h` .. `DEFAULT_TIME_TO=now`.
- **Limits:** `MAX_QUERY_ROWS`, `QUERY_TIMEOUT_SECONDS`, `MAX_WINDOW_POINTS`.
- **AI:** `AI_PROVIDER` (`gateway` | `openai-compatible`) + `AI_MODEL` — no model
  is baked in; this is a deliberate open decision (see architecture doc).
  The `openai-compatible` path works with any OpenAI-compatible endpoint:
  - **OpenRouter:** set `OPENAI_BASE_URL=https://openrouter.ai/api/v1`,
    `OPENAI_API_KEY` to your OpenRouter key, and `AI_MODEL` to any OpenRouter
    model slug (e.g. `openai/gpt-4o-mini`).
  - **OpenCode Go:** set `OPENAI_BASE_URL` and `OPENAI_API_KEY` to the values
    provided by OpenCode Go. Only models that expose an OpenAI-compatible
    `/chat/completions` interface are supported via this path.

See [`.env.example`](.env.example) for the complete list.

## Scripts

```bash
npm run dev      # dev server
npm run build    # production build
npm run start    # run the production build
npm run lint     # eslint (flat config)
npm test         # node --test (schema, auth, SQL safety, poller)
npm run migrate  # apply Postgres migrations
npm run seed     # looping metrics seeder
```

## Tests

`node --test` (native) via `tsx`, covering the highest-risk logic:

- `test/ir.test.ts` — shared IR schema (strict mode, duplicate panels, time expr).
- `test/claims.test.ts` — group parsing (highest role wins, fail-closed).
- `test/authorize.test.ts` — `can()` for every action incl. admin bypass and owner delete.
- `test/sql-safety.test.ts` — SQL denylist/allowlist + server time injection + time resolution.
- `test/poller.test.ts` — delta cursors, poller identity/version replacement, subscriber ref-counting.

## Security notes

- Dev login is hard-disabled in production and cannot bypass OIDC.
- Keycloak tokens are verified with RS256 via JWKS (`OIDC_JWKS_URL`).
- Authorization is centralized in `can()` and never derived from a request's
  workspace field; the source is re-authorized on every execution.
