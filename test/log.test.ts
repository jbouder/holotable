import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createLogger,
  digest,
  LOG_FORMATS,
  LOG_LEVELS,
  log,
  newRequestContext,
  REDACTED,
  redactFields,
  redactString,
  requestIdFrom,
  runWithRequest,
  setLogger,
  traceContextFrom,
  type Fields,
  type LogLevelSetting,
} from "@/lib/log";
import { validateConfig } from "@/lib/config";
import { route, REQUEST_ID_HEADER } from "@/lib/http";
import { HttpError } from "@/lib/auth/authorize";

/** A logger that keeps its lines as parsed objects. */
function capture(level: LogLevelSetting = "debug") {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level,
    format: "json",
    sink: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    now: () => new Date("2026-09-22T12:00:00.000Z"),
  });
  return { logger, lines };
}

/** Redact one field and hand back what came out the other side. */
function redacted(fields: Fields): Record<string, unknown> {
  return redactFields(fields);
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/thing", { headers });
}

/* -------------------------------------------------------------------------- */

describe("line shape", () => {
  test("every line is JSON with a level, a timestamp, and a message", () => {
    const { logger, lines } = capture();
    logger.info("thing.happened", { count: 3 });

    assert.deepEqual(lines[0], {
      level: "info",
      time: "2026-09-22T12:00:00.000Z",
      msg: "thing.happened",
      count: 3,
    });
  });

  test("a level below the threshold writes nothing", () => {
    const { logger, lines } = capture("warn");
    logger.debug("nope");
    logger.info("nope");
    logger.warn("yes");
    logger.error("yes");

    assert.deepEqual(
      lines.map((l) => l.level),
      ["warn", "error"],
    );
  });

  test("silent admits nothing at all", () => {
    const { logger, lines } = capture("silent");
    logger.error("not even this");
    assert.equal(lines.length, 0);
  });

  test("a child logger adds its fields to every line", () => {
    const { logger, lines } = capture();
    logger.child({ component: "poller" }).info("tick", { dashboard: "d1" });
    assert.equal(lines[0].component, "poller");
    assert.equal(lines[0].dashboard, "d1");
  });

  test("pretty output puts a multi-line report on its own lines", () => {
    const lines: string[] = [];
    createLogger({
      level: "debug",
      format: "pretty",
      color: false,
      sink: (l) => lines.push(l),
      now: () => new Date("2026-09-22T12:00:00.000Z"),
    }).warn("config.warnings", { problems: 2, report: "first\nsecond" });

    // The scalar stays on the head line; the block is indented beneath it,
    // which is the whole point of the development format.
    assert.match(lines[0], /^12:00:00\.000 WARN {2}config\.warnings problems=2\n/);
    assert.ok(lines[0].endsWith("    first\n    second"));
  });
});

/* -------------------------------------------------------------------------- */

describe("redaction", () => {
  test("a password in a connection URL is removed, the user is kept", () => {
    assert.equal(
      redactString("postgresql://metrics_ro:hunter2@db.internal:5432/metrics"),
      `postgresql://metrics_ro:${REDACTED}@db.internal:5432/metrics`,
    );
  });

  test("credential-shaped assignments inside a string are removed", () => {
    for (const [input, needle] of [
      ["host=db password=hunter2 sslmode=require", "hunter2"],
      ['{"api_key": "abcd1234efgh"}', "abcd1234efgh"],
      ["OPENAI_API_KEY=sk-livekey000111222333444", "sk-livekey000111222333444"],
      ["Authorization: Bearer abcdef0123456789", "abcdef0123456789"],
    ] as const) {
      const out = redactString(input);
      assert.ok(!out.includes(needle), `leaked ${needle} from ${input}: ${out}`);
      assert.ok(out.includes(REDACTED), `nothing redacted in ${out}`);
    }
  });

  test("a JWT anywhere in a string is removed", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.5rNSNbnJ0T1WcVfKJIJtFbLEtxMPVfjA";
    const out = redactString(`session cookie ${jwt} rejected`);
    assert.equal(out, `session cookie ${REDACTED} rejected`);
  });

  test("a credential reaches the sink through no field, however deeply nested", () => {
    const out = redacted({
      source: {
        name: "prod metrics",
        dsn: "postgres://ro:s3cr3t@db:5432/m",
        config: { password: "hunter2", host: "db" },
      },
    });
    const serialized = JSON.stringify(out);
    assert.ok(!serialized.includes("s3cr3t"), serialized);
    assert.ok(!serialized.includes("hunter2"), serialized);
    // The non-secret parts survive, or the line would be useless.
    assert.ok(serialized.includes("prod metrics"));
    assert.ok(serialized.includes("db"));
  });

  test("a secret-shaped key is dropped whatever its value looks like", () => {
    assert.deepEqual(redacted({ sessionToken: "plainish" }), {
      sessionToken: REDACTED,
    });
    assert.deepEqual(redacted({ OPENAI_API_KEY: "x" }), { OPENAI_API_KEY: REDACTED });
    assert.deepEqual(redacted({ cookie: "a=b" }), { cookie: REDACTED });
  });

  test("secretRef names a secret rather than holding one, and survives", () => {
    assert.deepEqual(redacted({ secretRef: "TS_METRICS" }), { secretRef: "TS_METRICS" });
  });

  test("token counts are not mistaken for tokens", () => {
    assert.deepEqual(redacted({ inputTokens: 120, outputTokens: 8, tokens: 128 }), {
      inputTokens: 120,
      outputTokens: 8,
      tokens: 128,
    });
  });

  test("SQL and prompts are logged as a digest, never verbatim", () => {
    const sql = "SELECT * FROM metrics WHERE host = 'web-1'";
    const out = redacted({ sql, prompt: "show me cpu" });

    assert.deepEqual(out.sql, digest(sql));
    assert.equal((out.sql as { length: number }).length, sql.length);
    assert.ok(!JSON.stringify(out).includes("web-1"));
    assert.ok(!JSON.stringify(out).includes("show me cpu"));
  });

  test("the same statement digests to the same value, a different one does not", () => {
    assert.equal(digest("SELECT 1").sha256, digest("SELECT 1").sha256);
    assert.notEqual(digest("SELECT 1").sha256, digest("SELECT 2").sha256);
  });

  test("an Error becomes a redacted object rather than an empty one", () => {
    const err = new Error("connect failed for postgres://ro:pw@db:5432/m");
    (err as { code?: string }).code = "ECONNREFUSED";

    const out = redacted({ err }).err as Record<string, unknown>;
    assert.equal(out.name, "Error");
    assert.equal(out.code, "ECONNREFUSED");
    assert.ok(!String(out.message).includes(":pw@"));
    assert.ok(String(out.stack).length > 0);
  });

  test("a circular object is bounded instead of hanging", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    const serialized = JSON.stringify(redacted({ a }));
    assert.ok(serialized.includes("[truncated]"), serialized);
  });

  test("a huge string and a huge array are both capped", () => {
    const out = redacted({ blob: "x".repeat(5_000), items: Array(500).fill(1) });
    assert.ok((out.blob as string).length < 2_100);
    assert.equal((out.items as unknown[]).length, 51);
  });
});

/* -------------------------------------------------------------------------- */

describe("request context", () => {
  test("lines inside a request carry its id, route, workspace, and subject", () => {
    const { logger, lines } = capture();
    const ctx = newRequestContext(request(), "dashboards.list");
    ctx.workspaceId = "ws1";
    ctx.sub = "alice";

    runWithRequest(ctx, () => logger.info("inside"));
    logger.info("outside");

    assert.equal(lines[0].requestId, ctx.requestId);
    assert.equal(lines[0].route, "dashboards.list");
    assert.equal(lines[0].workspaceId, "ws1");
    assert.equal(lines[0].sub, "alice");
    assert.equal(lines[1].requestId, undefined);
  });

  test("the context survives an await, so nothing threads a logger", async () => {
    const { logger, lines } = capture();
    const ctx = newRequestContext(request(), "generate");

    await runWithRequest(ctx, async () => {
      await new Promise((r) => setImmediate(r));
      logger.info("after the await");
    });

    assert.equal(lines[0].requestId, ctx.requestId);
  });

  test("two concurrent requests do not see each other's context", async () => {
    const { logger, lines } = capture();
    const one = newRequestContext(request(), "a");
    const two = newRequestContext(request(), "b");

    await Promise.all([
      runWithRequest(one, async () => {
        await new Promise((r) => setTimeout(r, 10));
        logger.info("one");
      }),
      runWithRequest(two, async () => {
        logger.info("two");
      }),
    ]);

    const byMsg = new Map(lines.map((l) => [l.msg, l]));
    assert.equal(byMsg.get("one")?.requestId, one.requestId);
    assert.equal(byMsg.get("two")?.requestId, two.requestId);
    assert.notEqual(one.requestId, two.requestId);
  });
});

/* -------------------------------------------------------------------------- */

describe("request ids and trace context", () => {
  test("a well-formed inbound id is reused so a caller's id survives the hop", () => {
    assert.equal(
      requestIdFrom(request({ "x-request-id": "abc-123" }).headers),
      "abc-123",
    );
  });

  test("an id that could not be safely echoed is replaced", () => {
    // Header injection is what makes echoing an inbound value dangerous.
    assert.notEqual(requestIdFrom(request({ "x-request-id": "a b" }).headers), "a b");
    const long = "x".repeat(200);
    assert.notEqual(requestIdFrom(request({ "x-request-id": long }).headers), long);
    assert.match(requestIdFrom(request().headers), /^[0-9a-f-]{36}$/);
  });

  test("a W3C traceparent becomes trace and span ids on every line", () => {
    const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
    const { logger, lines } = capture();
    runWithRequest(newRequestContext(request({ traceparent }), "query"), () =>
      logger.info("x"),
    );

    assert.equal(lines[0].traceId, "4bf92f3577b34da6a3ce929d0e0e4736");
    assert.equal(lines[0].spanId, "00f067aa0ba902b7");
  });

  test("a malformed or all-zero traceparent is ignored", () => {
    for (const value of [
      "garbage",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
    ]) {
      assert.equal(traceContextFrom(request({ traceparent: value }).headers), undefined);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("route()", () => {
  test("the response carries the request id and the outcome is logged once", async () => {
    const { logger, lines } = capture();
    const restore = setLogger(logger);
    try {
      const handler = route("thing.get", () => Response.json({ ok: true }));
      const response = await handler(request({ "x-request-id": "req-1" }));

      assert.equal(response.headers.get(REQUEST_ID_HEADER), "req-1");
      assert.equal(lines.length, 1);
      assert.equal(lines[0].msg, "request.completed");
      assert.equal(lines[0].requestId, "req-1");
      assert.equal(lines[0].route, "thing.get");
      assert.equal(lines[0].status, 200);
      assert.equal(lines[0].method, "GET");
      assert.equal(typeof lines[0].durationMs, "number");
    } finally {
      restore();
    }
  });

  test("a thrown HttpError becomes its status and logs at warn, not error", async () => {
    const { logger, lines } = capture();
    const restore = setLogger(logger);
    try {
      const handler = route("thing.get", () => {
        throw new HttpError(404, "thing not found");
      });
      const response = await handler(request());

      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "thing not found" });
      assert.equal(lines.at(-1)?.level, "warn");
      assert.equal(lines.at(-1)?.msg, "request.rejected");
    } finally {
      restore();
    }
  });

  test("an unexpected throw is a 500 whose detail exists only in the log", async () => {
    const { logger, lines } = capture();
    const restore = setLogger(logger);
    try {
      const handler = route("thing.get", () => {
        throw new Error("password=hunter2 rejected by db");
      });
      const response = await handler(request());

      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { error: "internal error" });

      const unhandled = lines.find((l) => l.msg === "request.unhandled_error");
      const err = unhandled?.err as { message: string };
      assert.ok(err.message.includes("rejected by db"));
      assert.ok(!err.message.includes("hunter2"), err.message);
      assert.equal(lines.at(-1)?.msg, "request.failed");
      assert.equal(lines.at(-1)?.level, "error");
    } finally {
      restore();
    }
  });

  test("a redirect, whose headers are immutable, still carries the id", async () => {
    const handler = route("thing.go", () => Response.redirect("http://localhost/x", 302));
    const response = await handler(request({ "x-request-id": "req-2" }));

    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "http://localhost/x");
    assert.equal(response.headers.get(REQUEST_ID_HEADER), "req-2");
  });

  test("quiet drops a healthy probe to debug but never a failure", async () => {
    const { logger, lines } = capture("info");
    const restore = setLogger(logger);
    try {
      await route("health", () => Response.json({ ok: true }), { quiet: true })(
        request(),
      );
      assert.equal(lines.length, 0);

      await route("ready", () => Response.json({ e: 1 }, { status: 503 }), {
        quiet: true,
      })(request());
      assert.equal(lines.at(-1)?.msg, "request.failed");
    } finally {
      restore();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("configuration", () => {
  test("the logger's vocabularies and the config schema's have not drifted", () => {
    // `src/lib/config.ts` spells these out rather than importing them, because
    // it is reachable from the browser bundle and this module is not.
    for (const level of LOG_LEVELS) {
      assert.deepEqual(
        validateConfig({ LOG_LEVEL: level }).filter((p) => p.variable === "LOG_LEVEL"),
        [],
        `${level} should be a valid LOG_LEVEL`,
      );
    }
    for (const format of LOG_FORMATS) {
      assert.deepEqual(
        validateConfig({ LOG_FORMAT: format }).filter((p) => p.variable === "LOG_FORMAT"),
        [],
        `${format} should be a valid LOG_FORMAT`,
      );
    }
  });

  test("the exported logger forwards to whatever was last installed", () => {
    const { logger, lines } = capture();
    const restore = setLogger(logger);
    log.info("through the forwarder");
    restore();
    log.info("after the restore");

    assert.deepEqual(
      lines.map((l) => l.msg),
      ["through the forwarder"],
    );
  });
});
