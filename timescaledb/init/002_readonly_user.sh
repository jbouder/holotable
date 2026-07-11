#!/usr/bin/env bash
set -euo pipefail

RO_USER="${TS_METRICS_USERNAME:-metrics_ro}"
RO_PASSWORD="${TS_METRICS_PASSWORD:-readonly}"

if [[ ! "${RO_USER}" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  echo "TS_METRICS_USERNAME is not a valid PostgreSQL role name" >&2
  exit 1
fi

psql --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  --set=ro_user="${RO_USER}" --set=ro_password="${RO_PASSWORD}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN', :'ro_user')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'ro_user') \gexec
SELECT format(
  'ALTER ROLE %I PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',
  :'ro_user',
  :'ro_password'
) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'ro_user') \gexec
SELECT format('GRANT USAGE ON SCHEMA metrics TO %I', :'ro_user') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA metrics TO %I', :'ro_user') \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES IN SCHEMA metrics GRANT SELECT ON TABLES TO %I',
  :'ro_user'
) \gexec
SQL
