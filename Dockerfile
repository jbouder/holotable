# Holotable images.
#
# Three publishable targets, all from this one file so they share one build
# of the app (#612):
#
#   runtime    (default) the Next.js standalone server. Nothing but the traced
#              server bundle, its static assets, and `public/`.
#   migrate    the one-shot job image for `scripts/migrate.ts` and
#              `scripts/seed.ts`; carries `tsx` and the dependencies it needs.
#   quickstart the all-in-one evaluation image (#253): TimescaleDB, the server
#              and the demo jobs in one container. See its section below.
#
# `next build` runs once, in the `build` stage, on glibc. Its output is
# JavaScript and static assets and does not depend on the base image; what
# does is `node_modules`, whose native packages npm picks for the libc it runs
# on. So each image installs its own dependencies on its own base and copies
# the built app from `build`: buildx builds it once, and the next target
# built in the same run (or from the same cache) reports it CACHED.
# `migrate` runs the scripts from source and copies nothing from it.
#
# The base is pinned by digest so every stage builds from the same bytes on
# every machine; Dependabot keeps the digests current (#37). The Debian stages
# derive from `base`; the quick-start stages name their own two Alpine bases.
FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# The unprivileged user the Debian targets run as.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
# Where compose mounts the files demo's volume (#574): the seeder writes it,
# the app and the smoke test read it. Owned by that user here so a fresh named
# volume, which takes the ownership of the directory it is first mounted on,
# is writable by the seeder whichever container mounts it first.
RUN mkdir -p /data/duckdb && chown nextjs:nodejs /data/duckdb

# ---- deps ----
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
# The one build of the app every image copies from.
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- migrate ----
# One-shot job image: `docker compose` runs `migrate`, `seed`, the
# self-monitoring collector and the smoke test from it.
# The scripts are TypeScript run through `tsx`, so this stage takes the full
# lockfile-resolved `node_modules` from `deps`. It is a job image that exits;
# its size does not matter the way the long-running `runtime` does.
FROM base AS migrate
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY migrations ./migrations
COPY scripts ./scripts
# The scripts share code with the app rather than restating it: the seeder
# writes the committed self-monitoring spec, and the smoke test runs a panel
# through the same guard and executor `POST /api/query` uses. `tsconfig.json`
# comes with it because that is where tsx reads the `@/*` alias from.
COPY tsconfig.json ./tsconfig.json
COPY src ./src

USER nextjs
CMD ["node", "node_modules/.bin/tsx", "scripts/migrate.ts"]

# ---- quick start ----
# Holotable quick start: one image, one command, live dashboards (#253).
#
#   docker run -p 3000:3000 ghcr.io/jbouder/holotable:quickstart
#
# TimescaleDB, the Next.js server, the seeder and the self-monitoring collector
# in one container, supervised by deploy/quickstart/entrypoint.sh, signed in
# with AUTH_MODE=local (#600: the one person running it is its owner, and can
# add sources and upload files) and no `.env`. It is an evaluation topology:
# one instance, no backups, no Keycloak. The same image runs the hosted demo
# (#254), which sets AUTH_MODE=demo itself (deploy/cloudflare/demo/src/policy.ts).
# Production is the runtime image and the Helm chart.
#
# Build from the repository root:
#   docker build --target quickstart -t holotable:quickstart .
#
# The final stage is the timescaledb image, which is Alpine (musl), and
# `@duckdb/node-api` (#572) loads a native binding built for one libc. The app
# itself is not native: it comes from the shared `build` stage above, built
# once on glibc (#612). What is native is node_modules, so `quickstart-deps`
# installs it here on Alpine, where npm and the binding's own loader pick the
# musl builds.
#
# `--omit=dev`: the image runs the server and, through `tsx` (a dependency
# for this reason), the scripts, which import only production packages
# through src/. No compiler, linter or test runner. Then out go the packages
# npm installs as optional dependencies that nothing here loads: Next's
# compiler (`@next/swc-*`, which `next build` uses and the server never
# does; the standalone trace leaves it out too), the image library the
# server does not use (sharp and `@img/*`, #498), and the glibc DuckDB
# bindings, which npm installs beside the musl ones because their packages
# declare no `libc` and which the binding's loader never picks on musl.
FROM node:24-alpine3.23@sha256:e44c87c7dd212720eb00469aeac89504ca2be77b8f0d6dbffb30665d5fcc59e1 AS quickstart-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
  && rm -rf node_modules/@next/swc-* node_modules/sharp node_modules/@img \
    node_modules/@duckdb/node-bindings-linux-x64 \
    node_modules/@duckdb/node-bindings-linux-arm64

FROM timescale/timescaledb:2.30.2-pg16@sha256:6f139d56042989bd35f50ba5986e492cd32e35cc6778c50be2659add298dc09f AS quickstart

# Node 24 from the same Alpine release `quickstart-deps` uses (3.23). `--upgrade` with
# sqlite-libs because Alpine's node links SQLite's session extension, which the
# older sqlite-libs already in the base image lacks ("Error relocating
# /usr/bin/node: sqlite3session_*"). Then the unprivileged user every Node
# process runs as; Postgres keeps the image's own `postgres`.
RUN apk add --no-cache --upgrade "nodejs~24" sqlite-libs \
  && addgroup -S -g 1001 holotable \
  && adduser -S -D -H -u 1001 -G holotable holotable

WORKDIR /app
# The musl install, then the app from the shared glibc `build` stage: the
# standalone server (server.js, its package.json and its .next) without the
# standalone's traced node_modules. The server resolves every package from
# the musl install instead. The trace is not used here because it is the
# runtime image's: its libduckdb.so is the glibc one (next.config.ts adds it,
# #615), and the scripts need packages the server never imports.
COPY --from=quickstart-deps /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone/server.js /app/.next/standalone/package.json ./
COPY --from=build /app/.next/standalone/.next ./.next
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY migrations ./migrations
COPY src ./src
RUN mkdir -p .next/cache && chown -R holotable:holotable .next/cache

# DUCKDB_SOURCES_DIR (#600): uploads land under uploads/, the seeder writes the
# files demo under demo/ when -e SEED_DEMO_FILES=true opts in, and a directory of your own mounts read-only beside
# them (-v "$PWD/files:/var/lib/holotable/files/mine:ro"). Owned by the app's
# user, which every Node process runs as, so both can create their
# subdirectories; a named volume mounted here starts from this ownership.
RUN mkdir -p /var/lib/holotable/files \
  && chown -R holotable:holotable /var/lib/holotable

# Runs once, on an empty data directory, after the image's own TimescaleDB
# install and tuning scripts: the metrics schema and the read-only role.
COPY timescaledb/init/ /docker-entrypoint-initdb.d/
COPY deploy/quickstart/entrypoint.sh /usr/local/bin/holotable-quickstart

# Everything here is non-secret or loopback-only. Postgres listens on
# 127.0.0.1 alone (entrypoint.sh), so its password guards nothing reachable from
# outside the container. SESSION_SECRET and METRICS_TOKEN are generated at boot
# when unset. The model is optional: pass AI_MODEL and OPENAI_API_KEY (and
# OPENAI_BASE_URL / OPENAI_API) with -e to turn on generation, or add one on
# the Models page. TS_METRICS is granted to both workspaces the seeder may
# fill: `local` here, `demo` when the hosted demo sets AUTH_MODE=demo.
#
# NO_TS_TUNE skips the base image's 001_timescaledb_tune.sh. On a host that
# advertises cgroup v2 without a memory.max file (Cloudflare Containers), the
# script computes "0MB" and timescaledb-tune panics, which aborts initdb. The
# stock settings are plenty for a demo-sized database.
# A heap ceiling (#495): this container also runs Postgres, so the app takes
# half a gigabyte rather than V8's guess from the host. Override with -e.
ENV NODE_OPTIONS=--max-old-space-size=512
ENV NODE_ENV=production \
    NO_TS_TUNE=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    AUTH_MODE=local \
    SESSION_COOKIE_SECURE=false \
    POSTGRES_USER=holotable \
    POSTGRES_PASSWORD=holotable \
    POSTGRES_DB=holotable \
    TIMESCALEDB_TELEMETRY=off \
    DATABASE_URL=postgresql://holotable:holotable@127.0.0.1:5432/holotable \
    TIMESCALEDB_URL=postgresql://holotable:holotable@127.0.0.1:5432/holotable \
    SOURCE_SECRET_REFS=TS_METRICS:demo,local \
    DUCKDB_SOURCES_DIR=/var/lib/holotable/files \
    TS_METRICS_HOST=127.0.0.1 \
    TS_METRICS_PORT=5432 \
    TS_METRICS_USERNAME=metrics_ro \
    TS_METRICS_PASSWORD=readonly \
    SEED_BACKFILL=6h \
    METRICS_URL=http://127.0.0.1:3000/api/metrics \
    SHUTDOWN_GRACE_MS=5000

# Build identity for GET /api/health. Last, so changing it never invalidates a
# cached layer.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

EXPOSE 3000
# Liveness of the server only. A boot is initdb, migrations and a backfill
# before the server starts, hence the long start period.
HEALTHCHECK --interval=15s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["holotable-quickstart"]

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production

# `next build` with `output: "standalone"` traces the server's runtime
# dependencies (including the externalized `pg` and `libpg-query`, WebAssembly
# binary included) into .next/standalone/node_modules, with the glibc
# libduckdb.so the tracer cannot see added by next.config.ts (#615). That is
# the whole dependency tree this image needs; the full `node_modules`, `scripts/`, and
# `migrations/` belong to the `migrate` target.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
# `public/` is empty today — the favicon is an App Router route file at
# src/app/favicon.ico — and git does not track empty directories, so it is held
# open by public/.gitkeep. Do not delete that file: without it this COPY fails
# the image build on a fresh checkout while `next build` still succeeds, so the
# breakage only shows up here.
COPY --from=build /app/public ./public

# Build identity for GET /api/health, so a running container can say which
# build it is. Optional: unset reads "unknown", and the version falls back to
# package.json. Pass it with `--build-arg GIT_COMMIT=$(git rev-parse HEAD)`.
# Last, and after every COPY, so changing it never invalidates a cached layer.
ARG GIT_COMMIT=""
ENV GIT_COMMIT=$GIT_COMMIT

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
# Hand SIGTERM/SIGINT to the app's own handler (src/lib/shutdown.ts) instead of
# Next's, which exits 143 without draining. `node server.js` is PID 1 here, so
# the signal from `docker stop` or a pod eviction arrives directly.
ENV NEXT_MANUAL_SIG_HANDLE=true
# A heap ceiling for `docker run` with no other say (#495): V8 otherwise sizes
# its heap from the host, not the container, and pressure ends in an OOM kill.
# Sized for a 1 GiB container; the Helm chart derives it from the memory limit
# instead, and `-e NODE_OPTIONS=...` overrides it.
ENV NODE_OPTIONS=--max-old-space-size=768
# Liveness only: /api/health answers whenever the process is serving, with no
# I/O. The slim base has no curl or wget, so the probe is Node's own fetch.
# Readiness (database, Keycloak) is /api/ready, which an orchestrator probes
# separately; Docker has one health state, and it is liveness that belongs in
# it — a container is not broken because its database went away.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.js"]
