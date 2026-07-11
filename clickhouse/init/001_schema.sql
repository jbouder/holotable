-- ClickHouse metrics store: schema + AggregatingMergeTree rollup.
--
-- The raw table holds per-request events. A materialized view maintains a
-- 1-minute rollup using AggregatingMergeTree so dashboards can query either the
-- raw events or the pre-aggregated rollup.

CREATE DATABASE IF NOT EXISTS metrics;

-- Raw per-request events.
CREATE TABLE IF NOT EXISTS metrics.http_requests
(
    ts          DateTime64(3) DEFAULT now64(3),
    service     LowCardinality(String),
    route       LowCardinality(String),
    status      UInt16,
    duration_ms Float64,
    bytes       UInt64
)
ENGINE = MergeTree
ORDER BY (service, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY;

-- 1-minute rollup target (AggregatingMergeTree).
CREATE TABLE IF NOT EXISTS metrics.http_requests_1m
(
    minute        DateTime,
    service       LowCardinality(String),
    route         LowCardinality(String),
    requests      AggregateFunction(count, UInt64),
    duration_state AggregateFunction(quantiles(0.5, 0.95, 0.99), Float64),
    errors        AggregateFunction(countIf, UInt8),
    bytes_sum     AggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree
ORDER BY (service, route, minute);

-- Materialized view populating the rollup as data arrives.
CREATE MATERIALIZED VIEW IF NOT EXISTS metrics.http_requests_1m_mv
TO metrics.http_requests_1m
AS
SELECT
    toStartOfMinute(ts)                              AS minute,
    service,
    route,
    countState()                                     AS requests,
    quantilesState(0.5, 0.95, 0.99)(duration_ms)     AS duration_state,
    countIfState(status >= 500)                      AS errors,
    sumState(bytes)                                  AS bytes_sum
FROM metrics.http_requests
GROUP BY minute, service, route;
