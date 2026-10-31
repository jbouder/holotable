---
title: Quick start
description: Try Holotable with one docker run, integrate it with Docker Compose, run it with Helm.
sidebar:
  order: 2
---

Three steps, from trying Holotable to running it: **`docker run`** to evaluate,
**Docker Compose** to integrate, **Helm** for production. Or skip all three:
the [public demo](https://holotable-demo.vibeproject.workers.dev) runs the same
image as step 1 in [demo mode](/admin/demo-mode/#demo-mode), reset whenever it
sleeps ([Hosted demo](/operations/cloudflare-demo/)).

## 1. Evaluate with `docker run`

```bash
docker run -p 3000:3000 ghcr.io/jbouder/holotable:quickstart
```

Open `http://localhost:3000`. There is no login: the image runs in [local
mode](/admin/demo-mode/#local-mode), which signs you in as the server's owner,
a source admin of one workspace, `local`. Bring your own data first:

1. Open **Data sources**, choose **Add source**, then **or enter
   configuration manually** and **Upload files**.
2. Pick a CSV, JSON or Excel (`.xlsx`) file, or try a sample the app ships
   (**household expenses**, a CSV, **workouts**, JSON lines, or **home
   energy**, a workbook of two sheets), then **Upload**. Its tables are
   discovered for you; check them and **Create source**.
3. If a table's columns read as spending, an activity log or daily
   measurements (each sample does), the page offers **Start from:** that
   starter dashboard right after **Create source**: one click opens it on
   **New dashboard**, built from your columns with no model, and **Save
   dashboard** keeps it. Otherwise, or for something else, ask for a
   dashboard on **New dashboard** once a model is configured (below), or
   write a panel's SQL yourself in the editor.

One container holds TimescaleDB, the app, the demo seeder and the
self-monitoring collector. It needs no `.env`, no Keycloak and no key. The
seeder writes six hours of demo history before streaming, so the four seeded
dashboards (**Demo service health**, **Demo fleet**, **Demo host detail** and
**Holotable self-monitoring**) are full within seconds.

| Option | Effect |
| --- | --- |
| `-e AI_MODEL=… -e OPENAI_API_KEY=…` (and `OPENAI_BASE_URL`, `OPENAI_API`) | Turns on generation and chat. Not needed with Ollama or LM Studio running on your machine: their models are found on their own and listed under **Detected on this machine** on the **Models** page ([A model on your machine](/admin/demo-mode/#a-model-on-your-machine)). Without any, those pages say what to do; you can also add a model on the **Models** page. |
| `-v holotable-data:/var/lib/postgresql/data` | Keeps the data: dashboards, sources, and your favorites and chats. A restart fills only the history it missed. |
| `-v holotable-files:/var/lib/holotable/files` | Keeps uploaded files across runs. Without it an upload's source outlives its files. |
| `-v "$PWD/files:/var/lib/holotable/files/mine:ro"` | Reads a directory of your own as well: the DuckDB path picker offers `mine` beside your uploads ([DuckDB files](/admin/duckdb/)). |
| `-e SESSION_SECRET=<32+ random characters>` | Keeps your session across restarts. Unset, one is generated per run, and a restart signs you in again without a word; nothing you saved is lost. |
| `-e SEED_BACKFILL=1d` | More or less history on a fresh start, at most `7d`. |
| `-e SEED_DEMO_FILES=true` | Adds the **Demo files** dashboard and DuckDB source over Parquet, CSV and JSON files the seeder writes ([The files demo](/operations/demo-data/#the-files-demo)). |

`docker stop` shuts it down cleanly within Docker's default ten seconds. The
image follows `main`; `ghcr.io/jbouder/holotable:<version>-quickstart` pins a
release.

The quick-start image has no Prometheus and no Loki, so it shows the SQL
demo sources, and the DuckDB one with `SEED_DEMO_FILES=true`. The [Prometheus
self-monitoring dashboard](/operations/demo-data/#the-prometheus-twin) and a
Prometheus source to try PromQL against come with Docker Compose's
`prometheus` profile, below, and the [Holotable logs
dashboard](/operations/demo-data/#the-logs-profile) and a Loki source to try
LogQL against with its `logs` profile.

:::danger
Everyone who can reach this container is signed in as its owner and can manage
its sources, including registering one that points at any host the container
can reach. Keep it on your own machine: on a shared network, publish the port
on localhost alone (`-p 127.0.0.1:3000:3000`). It is for trying Holotable,
never for real credentials.
:::

## 2. Integrate with Docker Compose

```bash
cp .env.example .env
# then set, in .env:
#   SESSION_SECRET        32+ random characters (openssl rand -hex 32)
#   AI_MODEL + its key    see AI provider; AI_PROVIDER defaults to openai-compatible
#   OIDC_CLIENT_SECRET=holotable-dev-secret   the local realm's client secret
docker compose up                  # timescaledb, keycloak, migrate, app, seed, self-metrics
```

The app service runs with `NODE_ENV=production`, so
[startup validation](/operations/startup-validation/) treats a missing value as
an error: the placeholder `SESSION_SECRET`, an empty `AI_MODEL` or an empty
`OIDC_CLIENT_SECRET` stops it from booting, and `docker compose logs app` says
which.

This brings up TimescaleDB, Keycloak, a one-shot migration job, the app, the
seeder and the self-monitoring collector, as separate services, with real
OIDC sign-in, and the same four seeded dashboards as the quick-start image.
Each of the others shows off a source kind and is opt-in:

- `docker compose --profile prometheus up` adds a Prometheus that scrapes the
  app; the seeder registers it as the `prometheus-self` source, with the
  **Holotable self-monitoring (Prometheus)** dashboard, so the stack has SQL
  and PromQL sources to compare.
- `docker compose --profile logs up` adds a Loki and a Grafana Alloy that
  ships every container's log lines to it; the seeder registers that Loki as
  `loki-self`, with a **Holotable logs** dashboard over the app's own JSON log
  lines, for LogQL.
- `SEED_DEMO_FILES=true docker compose up` has the seeder write a small
  directory of Parquet, CSV and JSON-lines files and register it as the
  **Demo files** DuckDB source, with its dashboard.

Profiles combine: `docker compose --profile prometheus --profile logs up`.
Sign in at
`http://localhost:3000` as **`demo` / `demo`**, a source-admin in the `demo`
workspace and a platform admin; see [the local realm](/admin/keycloak/#the-local-realm). The `seed` service
continuously inserts demo metrics and, once, creates the demo `demo`
workspace's sources and dashboards. See [Demo data](/operations/demo-data/)
for what gets created and how to tune it.

Nothing is built on your machine: the app and job services run the published
images, which are multi-arch (`linux/amd64`, `linux/arm64`), so Apple Silicon
pulls a native build.

| Image | What it is |
| --- | --- |
| `ghcr.io/jbouder/holotable:0.4.0`, `:latest` | The app, at a release. `latest` moves only on a release. |
| `ghcr.io/jbouder/holotable:0.4.0-migrate`, `:latest-migrate` | The job image that runs migrations, the seeder and the self-monitoring collector, at the same release. |
| `ghcr.io/jbouder/holotable:main`, `:main-migrate` | The same two, following the `main` branch. |
| `ghcr.io/jbouder/holotable:quickstart` | Everything in one container, for step 1, following `main`; `:0.4.0-quickstart` pins a release. |

`HOLOTABLE_TAG` in `.env` picks the tag. Leave it unset to follow `main`, or set
a release version such as `0.4.0` to pin one; see
[Images](/operations/kubernetes/#images) for every tag that is published. To run
your own changes, build them instead of pulling:

```bash
docker compose up --build          # builds this checkout under the same image names
```

## 3. Run it with Helm

See [Deploying on Kubernetes](/operations/kubernetes/).

## Developing

The shortest loop needs Node 22+ and Docker, and no Keycloak:

```bash
npm install
cp .env.example .env               # the first lines are all this loop needs
docker compose up -d postgres seed # TimescaleDB, migrations, demo data
npm run dev:demo                   # http://localhost:3000, demo sign-in
```

`npm run dev:demo` is `npm run dev` in [demo mode](/admin/demo-mode/#demo-mode), with
the Keycloak variables blanked for that run. Work on sign-in or authorization
runs `npm run dev` against the Compose realm instead.

Against your own TimescaleDB, without Docker:

```bash
npm install
cp .env.example .env               # edit DATABASE_URL, TIMESCALEDB_URL, secrets, AI_*
psql "$DATABASE_URL" -f timescaledb/init/001_schema.sql
npm run migrate                    # apply Postgres migrations
npm run seed                       # looping metrics seeder (+ demo source/dashboard)
npm run dev                        # http://localhost:3000
```

## Before you can generate anything

Three things must be true, and each has its own failure mode:

1. **An AI provider is configured.** `AI_MODEL` must be set; there is no default
   model. See [AI provider](/admin/models/). In local mode (the quick-start
   image), a model running in Ollama or LM Studio on the same machine is
   found instead ([A model on your machine](/admin/demo-mode/#a-model-on-your-machine)).
2. **A data source is registered** with a table catalog. Generation sends the
   model that catalog as metadata — it designs against a schema, not against data.
3. **The source's `secret_ref` is granted to its workspace and has
   credentials.** `SOURCE_SECRET_REFS` declares which workspace may use which
   ref (the Docker Compose stack grants `TS_METRICS` to `demo`), and the
   server needs `<REF>_USERNAME` / `<REF>_PASSWORD`. A source whose ref has no
   credentials saves fine but fails on **Test**. See
   [Source secret references](/admin/secret-references/).

## Scripts

`package.json` is authoritative; these are the ones you will reach for.

```bash
npm run dev            # dev server
npm run dev:demo       # dev server in demo mode (no Keycloak)
npm run build          # production build
npm run start          # run the production build
npm run lint           # Biome lint + format check, no writes
npm run lint:fix       # apply Biome's safe fixes
npm run format         # Biome format --write
npm run typecheck      # next typegen && tsc --noEmit
npm test               # node --test via tsx
npm run test:fuzz      # the property-based SQL, PromQL and LogQL guard suites alone (FUZZ_RUNS, FUZZ_SEED)
npm run test:integration # real-database suites against TimescaleDB (Docker)
npm run e2e            # Playwright journeys and axe scans against their own stack (Docker)
npm run e2e:down       # remove the e2e stack
npm run fixture:capture # save a stored dashboard spec as an IR test fixture
npm run config:check   # validate the environment as the server does at startup
npm run migrate        # apply Postgres migrations (--check, --dry-run, --down)
npm run migrate:verify # round-trip every migration against a scratch database
npm run seed           # looping metrics seeder (+ demo sources and dashboards)
npm run self-metrics   # scrape the app's own /api/metrics into metrics.holotable_self
npm run smoke          # check the seeded dashboards end to end, and each opt-in one that is on
```

## Pages

| Path | Purpose | Min role |
| --- | --- | --- |
| `/` | List dashboards in a workspace; `/dashboards` redirects here | viewer |
| `/dashboards/new` | Prompt → preview → save, with starter prompts built from the selected source's catalog | editor |
| `/dashboards/[id]` | Live viewer (SSE) with Live/Pause and a read-only chat assistant | viewer |
| `/dashboards/[id]/edit` | Panel CRUD/layout, single-panel NL edits, version save | editor |
| `/dashboards/[id]/versions` | Version history, diff, preview and restore | viewer (restore: editor) |
| `/embed/dashboards/[id]` | A [share link](/integrations/share-links/)'s read-only view, framable by the origins the link names | the link's token |
| `/models` | Server, workspace and personal models: add, test, choose the default | editor (demo: anyone) |
| `/explore` | Ask questions of your data in a conversation, with inline panels; `/chat` redirects here | viewer |
| `/settings` | Account, appearance, preferences, local data, shortcuts; AI context for editors; workspace AI limits and API tokens for admins. Reached from the account menu | signed in |
| `/data-sources` | Source CRUD / test / reviewed refresh, a catalog browser with per-column exposure, a structured form with table discovery, plus a natural-language drafter. Viewers get the list and the catalog browser read-only, without connection details or hidden columns | source-admin (read-only: viewer) |

Roles come from Keycloak group membership — see
[Authorization model](/architecture/authorization/).
