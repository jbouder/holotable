<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/src/assets/logo-dark.svg">
    <img alt="" src="docs/src/assets/logo-light.svg" width="96" height="96">
  </picture>
</p>

<h1 align="center">Holotable</h1>

<p align="center">
  <a href="https://github.com/jbouder/holotable/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jbouder/holotable/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/jbouder/holotable/actions/workflows/docs.yml"><img alt="Docs" src="https://github.com/jbouder/holotable/actions/workflows/docs.yml/badge.svg"></a>
  <a href="https://github.com/jbouder/holotable/actions/workflows/demo.yml"><img alt="Demo" src="https://github.com/jbouder/holotable/actions/workflows/demo.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: Apache 2.0" src="https://img.shields.io/github/license/jbouder/holotable"></a>
  <br>
  <a href="https://holotable-demo.vibeproject.workers.dev"><img alt="Live demo" src="https://img.shields.io/badge/demo-live-428eff"></a>
  <a href="https://holotable-docs.vibeproject.workers.dev"><img alt="Documentation" src="https://img.shields.io/badge/docs-holotable--docs-428eff"></a>
  <a href="https://github.com/jbouder/holotable/pkgs/container/holotable"><img alt="Container image" src="https://img.shields.io/badge/ghcr.io-holotable-2496ED?logo=docker&logoColor=white"></a>
  <br>
  <img alt="Next.js 16" src="https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs">
  <img alt="React 19" src="https://img.shields.io/badge/React-19-149ECA?logo=react&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="Node.js 22" src="https://img.shields.io/badge/Node.js-22-5FA04E?logo=nodedotjs&logoColor=white">
  <img alt="TimescaleDB" src="https://img.shields.io/badge/TimescaleDB-PostgreSQL-FDB515?logo=postgresql&logoColor=white">
</p>

Natural-language monitoring dashboards. Describe what you want to see; a language
model authors a **validated visualization spec** (SQL + chart config) — never the
data itself — and Holotable executes the guarded SQL against TimescaleDB and
streams the results live. Prometheus-compatible endpoints are sources too, with
panels written in guarded PromQL, and so are Loki-compatible ones, in guarded
LogQL, and Parquet, CSV, JSON or Excel files, through DuckDB.

**Stack:** Next.js 16 (App Router) · TypeScript · Tailwind v4 · Base UI · ECharts ·
TimescaleDB/PostgreSQL · Vercel AI SDK · Keycloak OIDC · Server-Sent Events. One
shared Zod IR (`src/lib/ir.ts`) is the contract between the model, the API,
persistence and the browser.

![Live dashboard view — error rate, latency and availability stats, a service map, and the request flow from service to route to status](docs/public/images/dashboard-view.png)

## Quick start

Try it in one container, with demo data and no sign-in (or open the
[public demo](https://holotable-demo.vibeproject.workers.dev)):

```bash
docker run -p 3000:3000 ghcr.io/jbouder/holotable:quickstart
```

Then open <http://localhost:3000>: you are its owner, so **Data sources → Add
source → or enter configuration manually → Upload files** takes a CSV or JSON file straight away. Keep it on your own
machine; everyone who can reach the port is signed in the same way. With
Docker Compose instead (Keycloak, real
sign-in as `demo` / `demo`, your own `.env`):

```bash
cp .env.example .env    # then set SESSION_SECRET, AI_MODEL and its key, and
                        # OIDC_CLIENT_SECRET=holotable-dev-secret (the local realm's)
docker compose up       # --profile logs adds Loki and Alloy, for LogQL
```

The [quick start](https://holotable-docs.vibeproject.workers.dev/getting-started/quick-start/)
covers both, Helm, and the development loop.

## Documentation

Everything is explained once, on the docs site
(<https://holotable-docs.vibeproject.workers.dev>, source in [`docs/`](docs/)):

- [Your first dashboard](https://holotable-docs.vibeproject.workers.dev/getting-started/your-first-dashboard/) — from an empty install to a live dashboard over your own database.
- [How it works](https://holotable-docs.vibeproject.workers.dev/concepts/how-it-works/) — a panel from prompt to live chart.
- [Invariants](https://holotable-docs.vibeproject.workers.dev/architecture/invariants/) — the guarantees the design rests on.
- [Configuration](https://holotable-docs.vibeproject.workers.dev/reference/configuration/) — every environment variable, generated from `src/lib/config.ts`.
- [Keycloak setup](https://holotable-docs.vibeproject.workers.dev/admin/keycloak/) — the OIDC client and group mapper.
- [API routes](https://holotable-docs.vibeproject.workers.dev/reference/api-routes/) and [Deploying on Kubernetes](https://holotable-docs.vibeproject.workers.dev/operations/kubernetes/).
- [Writing specs with Claude Code](https://holotable-docs.vibeproject.workers.dev/integrations/writing-specs-with-claude-code/) — the `/holotable` skill in `.claude/skills/holotable/` writes, reviews and fixes dashboard specs from your terminal.

## Contributing, security, license

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — local setup, the checks CI runs, conventions, and the invariants a change must not break.
- [`SECURITY.md`](SECURITY.md) — the trust model, and how to report a vulnerability privately.
- Licensed under the [Apache License 2.0](LICENSE); see [`NOTICE`](NOTICE).
