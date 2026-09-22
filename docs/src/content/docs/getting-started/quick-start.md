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
docker compose up --build          # timescaledb, keycloak, migrate, app, seed
```

This brings up TimescaleDB, Keycloak, a one-shot migration job, the app, and the
seeder. The `seed` service continuously inserts demo metrics and, once, creates
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
3. **Credentials exist in the server environment** for the source's
   `secret_ref`. A source whose `secret_ref` has no matching environment
   variables saves fine but fails on **Test**. See
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
