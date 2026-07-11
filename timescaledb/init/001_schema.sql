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
