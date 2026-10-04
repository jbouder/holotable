---
title: Quick start
description: Try Holotable with one docker run, integrate it with Docker Compose, run it with Helm.
sidebar:
  order: 2
---

Three steps, from trying Holotable to running it: **`docker run`** to evaluate,
**Docker Compose** to integrate, **Helm** for production.

## 1. Evaluate with `docker run`

```bash
docker run -p 3000:3000 ghcr.io/jbouder/holotable:quickstart
```

Open `http://localhost:3000`. One container holds TimescaleDB, the app, the
demo seeder and the self-monitoring collector. It needs no `.env`, no Keycloak
and no key. It signs every visitor in with [demo mode](/operations/demo-mode/)
and writes six hours of demo history before streaming, so the seeded dashboards
are full within seconds.

| Option | Effect |
| --- | --- |
| `-e AI_MODEL=… -e OPENAI_API_KEY=…` (and `OPENAI_BASE_URL`, `OPENAI_API`) | Turns on generation, Explore and chat. Without them those pages say what to set. |
| `-e SESSION_SECRET=<32+ random characters>` | Keeps sessions across restarts. Unset, one is generated per run. |
| `-v holotable-data:/var/lib/postgresql/data` | Keeps the data. A restart fills only the history it missed. |
| `-e SEED_BACKFILL=1d` | More or less history on a fresh start, at most `7d`. |

`docker stop` shuts it down cleanly within Docker's default ten seconds. The
image follows `main`; `ghcr.io/jbouder/holotable:<version>-quickstart` pins a
release.

:::caution
Everyone who can reach this container is signed in to the same demo workspace.
It is for trying Holotable, never for real data or credentials.
:::

## 2. Integrate with Docker Compose

```bash
cp .env.example .env
# set a strong SESSION_SECRET and your AI_PROVIDER/AI_MODEL (+ keys)
docker compose up                  # timescaledb, keycloak, migrate, app, seed
```

This brings up TimescaleDB, Keycloak, a one-shot migration job, the app, and the
seeder as separate services, with real OIDC sign-in. The `seed` service
continuously inserts demo metrics and, once, creates the demo `demo`
workspace's sources and dashboards. See [Demo data](/getting-started/demo-data/)
for what gets created and how to tune it.

Nothing is built on your machine: the app and job services run the published
images, which are multi-arch (`linux/amd64`, `linux/arm64`), so Apple Silicon
pulls a native build.

| Image | What it is |
| --- | --- |
| `ghcr.io/jbouder/holotable:main` | The app, following the `main` branch. |
| `ghcr.io/jbouder/holotable:main-migrate` | The job image that runs migrations, the seeder and the self-monitoring collector. |
| `ghcr.io/jbouder/holotable:quickstart` | Everything in one container, for step 1. |

`HOLOTABLE_TAG` in `.env` picks the tag. Leave it unset to follow `main`, or set
a release version such as `0.1.0` to pin one; see
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

`npm run dev:demo` is `npm run dev` in [demo mode](/operations/demo-mode/), with
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
   model. See [AI provider](/operations/ai-provider/).
2. **A data source is registered** with a table catalog. Generation sends the
   model that catalog as metadata — it designs against a schema, not against data.
3. **The source's `secret_ref` is granted to its workspace and has
   credentials.** `SOURCE_SECRET_REFS` declares which workspace may use which
   ref (the Docker Compose stack grants `TS_METRICS` to `demo`), and the
   server needs `<REF>_USERNAME` / `<REF>_PASSWORD`. A source whose ref has no
   credentials saves fine but fails on **Test**. See
   [Source secret references](/operations/secret-references/).

## Scripts

```bash
npm run dev      # dev server
npm run dev:demo # dev server in demo mode (no Keycloak)
npm run build    # production build
npm run start    # run the production build
npm run lint     # lint
npm test         # node --test (schema, auth, SQL safety, poller)
npm run migrate  # apply Postgres migrations
npm run seed     # looping metrics seeder
```

## Pages

| Path | Purpose | Min role |
| --- | --- | --- |
| `/dashboards` | List dashboards in a workspace | viewer |
| `/dashboards/new` | Prompt → preview → save, with starter prompts built from the selected source's catalog | editor |
| `/dashboards/[id]` | Live viewer (SSE) with Live/Pause and a read-only chat assistant | viewer |
| `/dashboards/[id]/edit` | Panel CRUD/layout, single-panel NL edits, version save | editor |
| `/explore` | Ad-hoc NL questions against editable sources | editor |
| `/data-sources` | Source CRUD / test / refresh, a structured form with table discovery, plus a natural-language drafter | source-admin |

Roles come from Keycloak group membership — see
[Authorization model](/architecture/authorization/).
