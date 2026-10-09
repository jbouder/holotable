/*
 * The settings the Prometheus client reads are fixed when `@/lib/config`
 * loads, so a test that needs its own imports this module first, before
 * anything that reads them.
 */
process.env.SOURCE_URL_ALLOWLIST = "127.0.0.1";
process.env.SOURCE_SECRET_REFS = "PROM_TEST:ws";
process.env.PROM_TEST_TOKEN = "t0ken";
process.env.PROM_TEST_USERNAME = "reader";
process.env.PROM_TEST_PASSWORD = "pa:ss";
process.env.MAX_RESULT_BYTES = "65536";
process.env.PROMETHEUS_MAX_SERIES = "3";
