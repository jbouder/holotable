import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { HttpError } from "@/lib/auth/authorize";
import { readJson } from "@/lib/http";

const Body = z.object({ hello: z.string() }).strict();

function postJson(body: string, headers: Record<string, string> = {}): Request {
  return new Request("https://example.test/api/thing", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

/** A body that arrives in chunks and declares no length, as a real upload can. */
function postChunked(total: number): Request {
  const chunk = new TextEncoder().encode("x".repeat(1024));
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= total) {
        controller.close();
        return;
      }
      controller.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
  return new Request("https://example.test/api/thing", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    // Required by undici for a streaming body.
    duplex: "half",
  } as RequestInit);
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${String(err)}`);
    return err.status;
  }
}

test("parses a body that fits under the cap", async () => {
  const parsed = await readJson(postJson('{"hello":"world"}'), Body, {
    maxBytes: 1024,
  });
  assert.deepEqual(parsed, { hello: "world" });
});

test("a body over the cap is a 400, not a 500", async () => {
  const big = JSON.stringify({ hello: "x".repeat(2048) });
  assert.equal(await statusOf(readJson(postJson(big), Body, { maxBytes: 512 })), 400);
});

test("a lying Content-Length does not get past the running total", async () => {
  const big = JSON.stringify({ hello: "x".repeat(2048) });
  const req = postJson(big, { "content-length": "10" });
  assert.equal(await statusOf(readJson(req, Body, { maxBytes: 512 })), 400);
});

test("a chunked body that declares no length is still capped", async () => {
  assert.equal(
    await statusOf(readJson(postChunked(64 * 1024), Body, { maxBytes: 4096 })),
    400,
  );
});

test("a malformed body is a 400 whether or not a cap is set", async () => {
  assert.equal(await statusOf(readJson(postJson("{not json"), Body)), 400);
  assert.equal(
    await statusOf(readJson(postJson("{not json"), Body, { maxBytes: 1024 })),
    400,
  );
  assert.equal(await statusOf(readJson(postJson(""), Body, { maxBytes: 1024 })), 400);
});

test("a body that fails the schema is a 400 naming the issue", async () => {
  const req = postJson('{"hello":"world","extra":1}');
  await assert.rejects(readJson(req, Body, { maxBytes: 1024 }), (err: unknown) => {
    assert.ok(err instanceof HttpError);
    assert.equal(err.status, 400);
    assert.match(err.message, /invalid request/);
    return true;
  });
});

test("without a cap the behaviour is unchanged", async () => {
  const parsed = await readJson(postJson('{"hello":"world"}'), Body);
  assert.deepEqual(parsed, { hello: "world" });
});
