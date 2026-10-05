# Holotable quick start: one image, one command, live dashboards (#253).
#
#   docker run -p 3000:3000 ghcr.io/jbouder/holotable:quickstart
#
# TimescaleDB, the Next.js server, the seeder and the self-monitoring collector
# in one container, supervised by entrypoint.sh, signed in with AUTH_MODE=demo
# and no `.env`. It is an evaluation and demo topology: one instance, no
# backups, no Keycloak. The same image runs the hosted demo (#254). Production
# is the runtime image and the Helm chart.
#
# Build from the repository root:
#   docker build -f deploy/quickstart/Dockerfile -t holotable:quickstart .
#
# The final stage is the timescaledb image, which is Alpine (musl), so the app
# is built here on Alpine too rather than copied from the root Dockerfile's
# Debian (glibc) stages: `next build` traces native packages such as sharp,
# and npm installs the binary for the libc it runs on.

# ---- deps ----
FROM node:22-alpine3.21@sha256:af8023ec879993821f6d5b21382ed915622a1b0f1cc03dbeb6804afaf01f8885 AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci

# ---- build ----
FROM deps AS build
COPY . .
RUN npm run build

# ---- quickstart ----
FROM timescale/timescaledb:2.30.2-pg16@sha256:6f139d56042989bd35f50ba5986e492cd32e35cc6778c50be2659add298dc09f AS quickstart

# Node 22 from the same Alpine release the build stage used. `--upgrade` with
# sqlite-libs because Alpine's node links SQLite's session extension, which the
# older sqlite-libs already in the base image lacks ("Error relocating
# /usr/bin/node: sqlite3session_*"). Then the unprivileged user every Node
# process runs as; Postgres keeps the image's own `postgres`.
RUN apk add --no-cache --upgrade "nodejs~22" sqlite-libs \
  && addgroup -S -g 1001 holotable \
  && adduser -S -D -H -u 1001 -G holotable holotable

WORKDIR /app
# The scripts (migrate, seed, self-metrics) run through tsx and import from
# src/, exactly as the root Dockerfile's `migrate` target does, so they need the
# full lockfile-resolved node_modules. The standalone server goes on top: its
# traced node_modules is a subset of the same versions.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY package.json tsconfig.json ./
COPY scripts ./scripts
COPY migrations ./migrations
COPY src ./src
RUN mkdir -p .next/cache && chown -R holotable:holotable .next/cache

# Runs once, on an empty data directory, after the image's own TimescaleDB
# install and tuning scripts: the metrics schema and the read-only role.
COPY timescaledb/init/ /docker-entrypoint-initdb.d/
COPY deploy/quickstart/entrypoint.sh /usr/local/bin/holotable-quickstart

# Everything here is non-secret or loopback-only. Postgres listens on
# 127.0.0.1 alone (entrypoint.sh), so its password guards nothing reachable from
# outside the container. SESSION_SECRET and METRICS_TOKEN are generated at boot
# when unset. The model is optional: pass AI_MODEL and OPENAI_API_KEY (and
# OPENAI_BASE_URL / OPENAI_API) with -e to turn on generation.
#
# NO_TS_TUNE skips the base image's 001_timescaledb_tune.sh. On a host that
# advertises cgroup v2 without a memory.max file (Cloudflare Containers), the
# script computes "0MB" and timescaledb-tune panics, which aborts initdb. The
# stock settings are plenty for a demo-sized database.
ENV NODE_ENV=production \
    NO_TS_TUNE=true \
    NEXT_TELEMETRY_DISABLED=1 \
    NEXT_MANUAL_SIG_HANDLE=true \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    AUTH_MODE=demo \
    SESSION_COOKIE_SECURE=false \
    POSTGRES_USER=holotable \
    POSTGRES_PASSWORD=holotable \
    POSTGRES_DB=holotable \
    TIMESCALEDB_TELEMETRY=off \
    DATABASE_URL=postgresql://holotable:holotable@127.0.0.1:5432/holotable \
    TIMESCALEDB_URL=postgresql://holotable:holotable@127.0.0.1:5432/holotable \
    SOURCE_SECRET_REFS=TS_METRICS:demo \
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
