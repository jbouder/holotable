/*
 * The settings the Loki client reads are fixed when `@/lib/config` loads, so
 * a test that needs its own imports this module first, before anything that
 * reads them.
 */
process.env.SOURCE_URL_ALLOWLIST = "127.0.0.1";
process.env.SOURCE_SECRET_REFS = "LOKI_TEST:ws";
process.env.LOKI_TEST_TOKEN = "l0ki-t0ken-secret";
process.env.LOKI_TEST_USERNAME = "reader";
process.env.LOKI_TEST_PASSWORD = "pa:ss-secret";
process.env.MAX_RESULT_BYTES = "65536";
process.env.LOKI_MAX_ENTRIES = "50";
process.env.LOKI_MAX_SERIES = "3";
