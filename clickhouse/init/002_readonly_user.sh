#!/usr/bin/env bash
# Create the read-only metrics user used by the app at query time.
#
# The app NEVER connects with a privileged user. This user has SELECT only on
# the metrics database and is constrained with readonly=1 so it cannot mutate
# data or change dangerous settings. The password is taken from the
# CH_METRICS_PASSWORD environment variable (the same secret the app resolves via
# the source secret_ref, e.g. CH_METRICS_PASSWORD).
set -euo pipefail

RO_USER="${CH_METRICS_USERNAME:-metrics_ro}"
RO_PASSWORD="${CH_METRICS_PASSWORD:-readonly}"

clickhouse-client -n <<SQL
CREATE USER IF NOT EXISTS ${RO_USER} IDENTIFIED WITH sha256_password BY '${RO_PASSWORD}';
GRANT SELECT ON metrics.* TO ${RO_USER};
-- Lock the profile to read-only; the user cannot change it.
ALTER USER ${RO_USER} SETTINGS readonly = 1 CONSTRAINT readonly CONST;
SQL
