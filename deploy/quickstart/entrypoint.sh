#!/bin/sh
# PID 1 of the quick-start image (#253). Starts, in order:
#
#   1. Postgres + TimescaleDB, through the image's own docker-entrypoint.sh,
#      which runs initdb and /docker-entrypoint-initdb.d only on an empty
#      data directory, so a mounted volume boots straight to step 2.
#   2. scripts/migrate.ts         applies pending migrations, idempotent
#   3. scripts/seed.ts            demo sources and dashboards, SEED_BACKFILL
#                                 history, then the live loop (background)
#   4. node server.js             the app, AUTH_MODE=demo (background)
#   5. scripts/self-metrics.ts    once /api/ready answers (background)
#
# On SIGTERM or SIGINT it stops the server first, which drains on its own
# (SHUTDOWN_GRACE_MS, 5s here), then the two loops, then Postgres with a fast
# shutdown. That fits Docker's default 10s stop timeout; raise it with
# `docker stop -t` or `--stop-timeout` if you raise SHUTDOWN_GRACE_MS.
#
# If the server or Postgres exits on its own, everything else is stopped and the
# container exits non-zero, so a restart policy can bring it back.
set -eu

APP_USER=holotable
SERVER_PID=""
SEED_PID=""
SELF_PID=""
PG_PID=""

log() { echo "[quickstart] $*"; }
as_app() { su-exec "$APP_USER" "$@"; }
secret() { node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"; }

stop_pid() {
  # $1 = pid (may be empty), $2 = signal
  if [ -n "$1" ] && kill -0 "$1" 2>/dev/null; then
    kill "-$2" "$1" 2>/dev/null || true
    wait "$1" 2>/dev/null || true
  fi
}

shutdown() {
  status="${1:-0}"
  trap - TERM INT
  log "stopping"
  stop_pid "$SERVER_PID" TERM
  stop_pid "$SELF_PID" TERM
  stop_pid "$SEED_PID" TERM
  # SIGINT is Postgres's fast shutdown: roll back open transactions, checkpoint, exit.
  stop_pid "$PG_PID" INT
  log "stopped"
  exit "$status"
}
trap 'shutdown 0' TERM INT

# --- secrets ---------------------------------------------------------------
if [ -z "${SESSION_SECRET:-}" ]; then
  SESSION_SECRET="$(secret)"
  export SESSION_SECRET
  log "SESSION_SECRET is not set; generated one for this run. Sessions will not survive a restart. Pass -e SESSION_SECRET=<32+ random characters> to keep them."
fi
if [ -z "${METRICS_TOKEN:-}" ]; then
  # Only the collector inside this container scrapes /api/metrics.
  METRICS_TOKEN="$(secret)"
  export METRICS_TOKEN
fi
if [ -z "${AI_MODEL:-}" ]; then
  log "No model configured: the dashboards, the live viewer and the SQL editor work; generation, Explore and chat are off. Pass -e AI_MODEL=... -e OPENAI_API_KEY=... to turn them on."
fi

# --- 1. postgres -----------------------------------------------------------
log "starting TimescaleDB"
docker-entrypoint.sh postgres -c listen_addresses=127.0.0.1 &
PG_PID=$!
# The official entrypoint initializes over a socket-only temporary server, so
# the loopback port answering means the real server is up.
until pg_isready -q -h 127.0.0.1 -p 5432 -U "$POSTGRES_USER"; do
  if ! kill -0 "$PG_PID" 2>/dev/null; then
    log "Postgres exited during startup"
    exit 1
  fi
  sleep 0.5
done
log "TimescaleDB is ready"

cd /app

# --- 2. migrations ---------------------------------------------------------
log "applying migrations"
as_app node node_modules/.bin/tsx scripts/migrate.ts

# --- 3. seeder -------------------------------------------------------------
log "starting the seeder (backfill: ${SEED_BACKFILL:-none})"
as_app node node_modules/.bin/tsx scripts/seed.ts &
SEED_PID=$!

# --- 4. server -------------------------------------------------------------
log "starting the server on port ${PORT}"
as_app node server.js &
SERVER_PID=$!

until node -e "fetch('http://127.0.0.1:${PORT}/api/ready').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "the server exited during startup"
    shutdown 1
  fi
  sleep 0.5
done
log "ready: open http://localhost:${PORT}"

# --- 5. self-monitoring ----------------------------------------------------
as_app node node_modules/.bin/tsx scripts/self-metrics.ts &
SELF_PID=$!

# Supervise. `sleep & wait` rather than a bare `sleep`, so a signal runs the
# trap at once instead of after the sleep.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$PG_PID" 2>/dev/null; do
  sleep 1 &
  wait $! || true
done
log "the server or Postgres exited unexpectedly"
shutdown 1
