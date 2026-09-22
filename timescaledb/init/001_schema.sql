CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE SCHEMA IF NOT EXISTS metrics;

CREATE TABLE IF NOT EXISTS metrics.http_requests
(
    ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
    service     TEXT NOT NULL,
    route       TEXT NOT NULL,
    status      SMALLINT NOT NULL,
    duration_ms DOUBLE PRECISION NOT NULL,
    bytes       BIGINT NOT NULL
);

SELECT create_hypertable(
    'metrics.http_requests',
    by_range('ts'),
    if_not_exists => TRUE
);

CREATE MATERIALIZED VIEW IF NOT EXISTS metrics.http_requests_1m
WITH (timescaledb.continuous) AS
SELECT
    time_bucket(INTERVAL '1 minute', ts) AS minute,
    service,
    route,
    count(*) AS requests,
    avg(duration_ms) AS avg_duration_ms,
    count(*) FILTER (WHERE status >= 500) AS errors,
    sum(bytes) AS bytes_sum
FROM metrics.http_requests
GROUP BY minute, service, route
WITH NO DATA;

SELECT add_continuous_aggregate_policy(
    'metrics.http_requests_1m',
    start_offset => INTERVAL '1 day',
    end_offset => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute',
    if_not_exists => TRUE
);

SELECT add_retention_policy(
    'metrics.http_requests',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- Second demo source: per-host infrastructure/system metrics.
CREATE TABLE IF NOT EXISTS metrics.system_metrics
(
    ts            TIMESTAMPTZ NOT NULL DEFAULT now(),
    host          TEXT NOT NULL,
    region        TEXT NOT NULL,
    cpu_pct       DOUBLE PRECISION NOT NULL,
    mem_pct       DOUBLE PRECISION NOT NULL,
    disk_pct      DOUBLE PRECISION NOT NULL,
    net_in_bytes  BIGINT NOT NULL,
    net_out_bytes BIGINT NOT NULL
);

SELECT create_hypertable(
    'metrics.system_metrics',
    by_range('ts'),
    if_not_exists => TRUE
);

SELECT add_retention_policy(
    'metrics.system_metrics',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);

-- Third demo source: Holotable's own Prometheus instruments (#54).
--
-- `scripts/self-metrics.ts` scrapes GET /api/metrics and lands one row per
-- series per scrape here, so the app can be pointed at itself through the
-- ordinary source registry. The eight label columns are the ones the app's own
-- instruments use; `labels` keeps the complete set so two series of the same
-- metric never collapse into one row.
CREATE TABLE IF NOT EXISTS metrics.holotable_self
(
    ts        TIMESTAMPTZ NOT NULL DEFAULT now(),
    metric    TEXT NOT NULL,
    labels    TEXT NOT NULL DEFAULT '',
    dashboard TEXT,
    source    TEXT,
    workspace TEXT,
    model     TEXT,
    direction TEXT,
    route     TEXT,
    reason    TEXT,
    outcome   TEXT,
    -- Histogram bucket bound. NULL for +Inf, so a panel can select the real
    -- buckets with `le IS NOT NULL` instead of writing the literal
    -- 'infinity' -- which the SQL guard refuses, that string being a valid
    -- PostgreSQL timestamp input.
    le        DOUBLE PRECISION,
    value     DOUBLE PRECISION NOT NULL
);

SELECT create_hypertable(
    'metrics.holotable_self',
    by_range('ts'),
    if_not_exists => TRUE
);

-- Every panel filters on `metric` first.
CREATE INDEX IF NOT EXISTS holotable_self_metric_ts_idx
    ON metrics.holotable_self (metric, ts DESC);

SELECT add_retention_policy(
    'metrics.holotable_self',
    drop_after => INTERVAL '7 days',
    if_not_exists => TRUE
);
