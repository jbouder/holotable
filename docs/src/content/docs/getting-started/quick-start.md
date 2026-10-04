---
title: Quick start
description: Run Holotable with Docker Compose, or locally against your own TimescaleDB.
sidebar:
  order: 2
---

## With Docker

```bash
cp .env.example .env
# set a strong SESSION_SECRET and your AI_PROVIDER/AI_MODEL (+ keys)
docker compose up                  # timescaledb, keycloak, migrate, app, seed
```

This brings up TimescaleDB, Keycloak, a one-shot migration job, the app, and the
seeder.

Nothing is built on your machine: the app and job services run the published
images, which are multi-arch (`linux/amd64`, `linux/arm64`), so Apple Silicon
pulls a native build.

| Image | What it is |
| --- | --- |
| `ghcr.io/jbouder/holotable:main` | The app, following the `main` branch. |
| `ghcr.io/jbouder/holotable:main-migrate` | The job image that runs migrations, the seeder and the self-monitoring collector. |

`HOLOTABLE_TAG` in `.env` picks the tag. Leave it unset to follow `main`, or set
a release version such as `0.1.0` to pin one; see
[Images](/operations/kubernetes/#images) for every tag that is published. To run
your own changes, build them instead of pulling:

```bash
docker compose up --build          # builds this checkout under the same image names
```
 The `seed` service continuously inserts demo metrics and, once, creates
the demo `demo` workspace sources and dashboards.

Open `http://localhost:3000`. See [Demo data](/getting-started/demo-data/) for
what gets created and how to tune it.

## Locally

Requirements: Node 22+ and a TimescaleDB instance.

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
