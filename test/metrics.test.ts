import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { GET, dynamic } from "@/app/api/metrics/route";
import { addressInAny, parseCidr, parseCidrList } from "@/lib/cidr";
import type { Environment } from "@/lib/config";
import { authorizeMetricsRequest } from "@/lib/metrics-access";
import {
  forgetDashboard,
  observePollerTick,
  observeQuery,
  OVERFLOW_LABEL,
  recordLlmRequest,
  recordLlmTokens,
  recordSqlRejection,
  renderMetrics,
  resetMetricsForTests,
  setActivePollers,
  setSseSubscribers,
} from "@/lib/metrics";

/**
 * Two things are worth testing here, and they are not the same thing.
 *
 * The **gate**: `/api/metrics` exports dashboard and source ids, per-workspace
 * model spend, and what the SQL guard is rejecting, without a session cookie
 * in front of it. Every case below that closes it is a case where leaving it
 * open would be the bug.
 *
 * The **cardinality**: a label that can take unboundedly many values turns a
 * scrape into an outage. The bound has to hold no matter how many ids the
 * process sees.
 */

const TOKEN = "s3cret-scrape-token-long-enough";

/** A scrape request, optionally carrying a token and a forwarded address. */
function scrape(opts: { token?: string; forwardedFor?: string; realIp?: string } = {}) {
  const headers = new Headers();
  if (opts.token !== undefined) headers.set("authorization", `Bearer ${opts.token}`);
  if (opts.forwardedFor !== undefined) {
    headers.set("x-forwarded-for", opts.forwardedFor);
  }
  if (opts.realIp !== undefined) headers.set("x-real-ip", opts.realIp);
  return new Request("http://app.internal/api/metrics", { headers });
}

beforeEach(() => {
  resetMetricsForTests();
  delete process.env.METRICS_TOKEN;
  delete process.env.METRICS_ALLOWED_CIDRS;
});

/* -------------------------------------------------------------------------- */

describe("metrics access", () => {
  const unconfigured: Environment = {};
  const tokenOnly: Environment = { METRICS_TOKEN: TOKEN };
  const cidrOnly: Environment = { METRICS_ALLOWED_CIDRS: "10.0.0.0/8, ::1" };
  const both: Environment = { ...tokenOnly, ...cidrOnly };

  it("is closed, and says nothing, until it is configured", () => {
    const access = authorizeMetricsRequest(scrape(), unconfigured);
    assert.equal(access.allowed, false);
    // 404, not 403: an unconfigured deployment does not advertise the route.
    assert.equal(access.allowed === false && access.status, 404);
  });

  it("refuses an unauthenticated scrape when a token is configured", () => {
    const access = authorizeMetricsRequest(scrape(), tokenOnly);
    assert.equal(access.allowed, false);
    assert.equal(access.allowed === false && access.status, 401);
  });

  it("refuses the wrong token", () => {
    const access = authorizeMetricsRequest(scrape({ token: "wrong" }), tokenOnly);
    assert.equal(access.allowed, false);
    assert.equal(access.allowed === false && access.status, 403);
  });

  it("admits the right token", () => {
    assert.equal(
      authorizeMetricsRequest(scrape({ token: TOKEN }), tokenOnly).allowed,
      true,
    );
  });

  it("accepts the bearer scheme case-insensitively, with surrounding space", () => {
    const req = new Request("http://app.internal/api/metrics", {
      headers: { authorization: `  bearer   ${TOKEN}  ` },
    });
    assert.equal(authorizeMetricsRequest(req, tokenOnly).allowed, true);
  });

  it("admits an address inside an allowlisted range when no token is set", () => {
    const access = authorizeMetricsRequest(
      scrape({ forwardedFor: "10.4.2.1" }),
      cidrOnly,
    );
    assert.equal(access.allowed, true);
  });

  it("refuses an address outside every allowlisted range", () => {
    const access = authorizeMetricsRequest(
      scrape({ forwardedFor: "203.0.113.9" }),
      cidrOnly,
    );
    assert.equal(access.allowed, false);
    assert.equal(access.allowed === false && access.status, 403);
  });

  it("refuses a scrape that carries no address at all", () => {
    const access = authorizeMetricsRequest(scrape(), cidrOnly);
    assert.equal(access.allowed, false);
  });

  it("reads the LAST forwarded hop, which is the one the proxy wrote", () => {
    // A client that injects an allowlisted address into X-Forwarded-For has it
    // appended to, not replaced: the proxy's own observation ends up last.
    const spoofed = authorizeMetricsRequest(
      scrape({ forwardedFor: "10.0.0.1, 203.0.113.9" }),
      cidrOnly,
    );
    assert.equal(spoofed.allowed, false);
    const genuine = authorizeMetricsRequest(
      scrape({ forwardedFor: "203.0.113.9, 10.0.0.1" }),
      cidrOnly,
    );
    assert.equal(genuine.allowed, true);
  });

  it("falls back to X-Real-IP", () => {
    assert.equal(
      authorizeMetricsRequest(scrape({ realIp: "10.1.1.1" }), cidrOnly).allowed,
      true,
    );
  });

  it("ignores a port on the forwarded address", () => {
    assert.equal(
      authorizeMetricsRequest(scrape({ forwardedFor: "10.1.1.1:54321" }), cidrOnly)
        .allowed,
      true,
    );
    assert.equal(
      authorizeMetricsRequest(scrape({ forwardedFor: "[::1]:54321" }), cidrOnly).allowed,
      true,
    );
  });

  it("requires BOTH when both are configured, so a token never loosens the gate", () => {
    // The address check trusts a header. If the two were ORed, setting a token
    // would leave a spoofable header as a way around it.
    assert.equal(
      authorizeMetricsRequest(scrape({ forwardedFor: "10.0.0.1" }), both).allowed,
      false,
      "address alone must not be enough once a token is configured",
    );
    assert.equal(
      authorizeMetricsRequest(scrape({ token: TOKEN, forwardedFor: "203.0.113.9" }), both)
        .allowed,
      false,
      "token alone must not be enough once an allowlist is configured",
    );
    assert.equal(
      authorizeMetricsRequest(scrape({ token: TOKEN, forwardedFor: "10.0.0.1" }), both)
        .allowed,
      true,
    );
  });

  it("drops a malformed allowlist entry instead of admitting on it", () => {
    const broken: Environment = { METRICS_ALLOWED_CIDRS: "not-an-address" };
    assert.equal(
      authorizeMetricsRequest(scrape({ forwardedFor: "10.0.0.1" }), broken).allowed,
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("CIDR matching", () => {
  it("matches inside an IPv4 prefix and not outside it", () => {
    const cidrs = parseCidrList("10.0.0.0/8,192.168.1.0/24");
    assert.equal(addressInAny("10.255.255.255", cidrs), true);
    assert.equal(addressInAny("192.168.1.42", cidrs), true);
    assert.equal(addressInAny("192.168.2.42", cidrs), false);
    assert.equal(addressInAny("11.0.0.1", cidrs), false);
  });

  it("handles a prefix that does not fall on a byte boundary", () => {
    const cidrs = parseCidrList("10.1.0.0/12");
    assert.equal(addressInAny("10.15.1.1", cidrs), true);
    assert.equal(addressInAny("10.16.1.1", cidrs), false);
  });

  it("treats a bare address as a host route", () => {
    const cidrs = parseCidrList("127.0.0.1");
    assert.equal(addressInAny("127.0.0.1", cidrs), true);
    assert.equal(addressInAny("127.0.0.2", cidrs), false);
  });

  it("matches IPv6, including the compressed and zoned forms", () => {
    const cidrs = parseCidrList("fd00::/8, ::1");
    assert.equal(addressInAny("fd12:3456::1", cidrs), true);
    assert.equal(addressInAny("::1", cidrs), true);
    assert.equal(addressInAny("fe80::1%eth0", cidrs), false);
    assert.equal(addressInAny("2001:db8::1", cidrs), false);
  });

  it("folds an IPv4-mapped IPv6 address to IPv4, so one entry covers both", () => {
    // A dual-stack listener reports an IPv4 peer as ::ffff:10.0.0.1.
    const cidrs = parseCidrList("10.0.0.0/8");
    assert.equal(addressInAny("::ffff:10.0.0.1", cidrs), true);
    assert.equal(addressInAny("::ffff:203.0.113.1", cidrs), false);
  });

  it("does not match an IPv4 address against an IPv6 range", () => {
    assert.equal(addressInAny("10.0.0.1", parseCidrList("::/0")), false);
  });

  it("rejects the shapes an allowlist could be fooled with", () => {
    for (const bad of [
      "",
      "10.0.0.1/33",
      "10.0.0.1/-1",
      "10.0.0.1/abc",
      "10.0.0.256",
      "010.0.0.1", // a leading-zero octet parses two ways
      "10.0.0",
      "10.0.0.1.2",
      "::1/129",
      "fd00::/8/8",
      "gg::1",
      "1:2:3:4:5:6:7",
      "1::2::3",
    ]) {
      assert.equal(parseCidr(bad), null, `${bad} must not parse`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the scrape body", () => {
  it("exports every instrument once real traffic has touched it", async () => {
    observePollerTick("dash-1", 0.42);
    observeQuery({ sourceId: "src-1", seconds: 0.1, ok: true, rows: 120 });
    observeQuery({ sourceId: "src-1", seconds: 0.2, ok: false });
    setSseSubscribers("dash-1", 3);
    setActivePollers(1);
    recordLlmTokens({
      workspaceId: "ws-1",
      model: "gpt-4o-mini",
      inputTokens: 900,
      outputTokens: 120,
    });
    recordLlmRequest("generate", "admitted");
    recordSqlRejection("catalog");

    const body = await renderMetrics();
    for (const name of [
      "holotable_poller_tick_duration_seconds",
      "holotable_query_duration_seconds",
      "holotable_query_rows",
      "holotable_sse_subscribers",
      "holotable_pollers_active",
      "holotable_llm_tokens_total",
      "holotable_llm_requests_total",
      "holotable_sql_validation_rejections_total",
    ]) {
      assert.ok(body.includes(`# TYPE ${name} `), `${name} is missing from the scrape`);
    }
    // The default process collectors ride along under the same prefix.
    assert.match(body, /holotable_process_cpu_seconds_total/);
  });

  it("labels what it exports the way a query would expect", async () => {
    observeQuery({ sourceId: "src-1", seconds: 0.1, ok: true, rows: 5 });
    setSseSubscribers("dash-1", 2);
    recordLlmTokens({
      workspaceId: "ws-1",
      model: "gpt-4o-mini",
      inputTokens: 10,
      outputTokens: 4,
    });

    const body = await renderMetrics();
    assert.match(
      body,
      /holotable_query_duration_seconds_count\{source="src-1",outcome="ok"\} 1/,
    );
    assert.match(body, /holotable_sse_subscribers\{dashboard="dash-1"\} 2/);
    assert.match(
      body,
      /holotable_llm_tokens_total\{workspace="ws-1",model="gpt-4o-mini",direction="input"\} 10/,
    );
    assert.match(
      body,
      /holotable_llm_tokens_total\{workspace="ws-1",model="gpt-4o-mini",direction="output"\} 4/,
    );
  });

  it("does not observe a row count for a query that failed", async () => {
    observeQuery({ sourceId: "src-1", seconds: 0.2, ok: false });
    const body = await renderMetrics();
    assert.ok(
      !body.includes('holotable_query_rows_count{source="src-1"}'),
      "a failed statement returned no rows; counting zero would flatten the histogram",
    );
  });

  it("stops exporting a dashboard once its poller is gone", async () => {
    setSseSubscribers("dash-gone", 1);
    assert.match(
      await renderMetrics(),
      /holotable_sse_subscribers\{dashboard="dash-gone"\}/,
    );
    forgetDashboard("dash-gone");
    assert.doesNotMatch(
      await renderMetrics(),
      /holotable_sse_subscribers\{dashboard="dash-gone"\}/,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("label cardinality", () => {
  it("caps distinct id values and folds the rest into one series", async () => {
    // 600 dashboards through a 500-value cap: the first 500 keep their id, the
    // remaining 100 land on a single overflow series.
    for (let i = 0; i < 600; i++) observePollerTick(`dash-${i}`, 0.01);

    const body = await renderMetrics();
    const series = new Set(
      [
        ...body.matchAll(
          /holotable_poller_tick_duration_seconds_count\{dashboard="([^"]+)"\}/g,
        ),
      ].map((m) => m[1]),
    );
    assert.equal(series.size, 501, "500 ids plus the overflow bucket");
    assert.ok(series.has(OVERFLOW_LABEL));
    assert.match(
      body,
      new RegExp(
        `holotable_poller_tick_duration_seconds_count\\{dashboard="${OVERFLOW_LABEL}"\\} 100`,
      ),
    );
  });

  it("caps each label independently", async () => {
    for (let i = 0; i < 600; i++) {
      observeQuery({ sourceId: `src-${i}`, seconds: 0.01, ok: true, rows: 1 });
    }
    // The source label overflowed; `outcome` is a fixed enum and is untouched.
    const body = await renderMetrics();
    assert.match(
      body,
      /holotable_query_duration_seconds_count\{source="other",outcome="ok"\} 100/,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("GET /api/metrics", () => {
  it("404s while unconfigured", async () => {
    const response = await GET(scrape());
    assert.equal(response.status, 404);
  });

  it("challenges an unauthenticated scrape", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    const response = await GET(scrape());
    assert.equal(response.status, 401);
    assert.match(response.headers.get("www-authenticate") ?? "", /^Bearer /);
  });

  it("serves the exposition format, uncached, to an authorized scrape", async () => {
    process.env.METRICS_TOKEN = TOKEN;
    recordSqlRejection("time");

    const response = await GET(scrape({ token: TOKEN }));
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.match(
      await response.text(),
      /holotable_sql_validation_rejections_total\{reason="time"\} 1/,
    );
  });

  it("is never prerendered", () => {
    assert.equal(dynamic, "force-dynamic");
  });
});
