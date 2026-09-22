import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiErrorFrom,
  apiErrorFromThrown,
  ERROR_KINDS,
  hintFor,
  isActionable,
  kindFromStatus,
  OPAQUE_MESSAGE,
  presentError,
  readApiError,
} from "@/lib/errors";

test("maps status codes to the kind they imply", () => {
  assert.equal(kindFromStatus(400), "validation");
  assert.equal(kindFromStatus(401), "authorization");
  assert.equal(kindFromStatus(403), "authorization");
  assert.equal(kindFromStatus(404), "not_found");
  assert.equal(kindFromStatus(409), "conflict");
  assert.equal(kindFromStatus(429), "rate_limit");
  assert.equal(kindFromStatus(500), "infrastructure");
  assert.equal(kindFromStatus(503), "infrastructure");
});

test("a 400 defaults to validation, not statement", () => {
  // Presenting a malformed request body as a query the user can edit would
  // send them to the SQL box for a problem that is not there.
  assert.equal(kindFromStatus(400), "validation");
});

test("only infrastructure is opaque", () => {
  for (const kind of ERROR_KINDS) {
    assert.equal(isActionable(kind), kind !== "infrastructure", kind);
  }
});

test("an actionable error keeps its real message and drops the request id", () => {
  const shown = presentError({
    error: 'column "durationms" does not exist',
    kind: "statement",
    requestId: "req-1",
  });
  assert.equal(shown.actionable, true);
  assert.equal(shown.message, 'column "durationms" does not exist');
  assert.equal(shown.requestId, undefined);
});

test("an infrastructure error is opaque and keeps the request id", () => {
  const shown = presentError({
    error: "connect ECONNREFUSED 10.0.0.5:5432",
    kind: "infrastructure",
    requestId: "req-2",
  });
  assert.equal(shown.actionable, false);
  assert.equal(shown.message, OPAQUE_MESSAGE);
  assert.equal(shown.requestId, "req-2");
  // Invariant 16: nothing about the host, the port, or the driver survives.
  assert.ok(!shown.message.includes("ECONNREFUSED"));
  assert.ok(!shown.message.includes("10.0.0.5"));
  assert.equal(shown.hint, undefined);
});

test("the timeField failure renders as a fix, not a second error", () => {
  const message =
    'time column "ts" is not produced by this query. Set the panel\'s timeField to the SELECT output alias of your time bucket (e.g. time_bucket(...) AS ts), or clear it when the result has no time column.';
  const hint = hintFor("statement", message);
  assert.ok(hint);
  assert.match(hint, /Alias the time bucket/);
});

test("recognised statement failures get their own next step", () => {
  assert.match(hintFor("statement", 'column "foo" does not exist') ?? "", /catalog/);
  assert.match(hintFor("statement", 'relation "bar" does not exist') ?? "", /catalog/);
  assert.match(
    hintFor("statement", "canceling statement due to statement timeout") ?? "",
    /time_bucket|Narrow/,
  );
  // An unrecognised statement failure still points at the query.
  assert.match(
    hintFor("statement", 'syntax error at or near "FRO"') ?? "",
    /Edit the query/,
  );
});

test("kinds with nothing specific to say offer no hint", () => {
  assert.equal(hintFor("infrastructure", "anything"), undefined);
  assert.equal(hintFor("unknown", "anything"), undefined);
});

test("every kind is handled by hintFor without throwing", () => {
  for (const kind of ERROR_KINDS) {
    assert.doesNotThrow(() => hintFor(kind, "some message"), kind);
  }
});

test("a body's own kind wins over the status", () => {
  const err = apiErrorFrom(400, { error: "bad column", kind: "statement" }, "req-3");
  assert.equal(err.kind, "statement");
  assert.equal(err.requestId, "req-3");
});

test("a body with no usable message is treated as infrastructure", () => {
  // An HTML error page from a proxy, or a redirect to the login form.
  assert.equal(apiErrorFrom(502, undefined).kind, "infrastructure");
  assert.equal(apiErrorFrom(502, undefined).error, OPAQUE_MESSAGE);
  assert.equal(apiErrorFrom(400, "<html>nope</html>").kind, "infrastructure");
});

test("a bogus kind in a body falls back to the status", () => {
  const err = apiErrorFrom(429, { error: "slow down", kind: "definitely-not-a-kind" });
  assert.equal(err.kind, "rate_limit");
});

test("readApiError picks up the request id from the response header", async () => {
  const res = new Response(JSON.stringify({ error: "nope", kind: "authorization" }), {
    status: 403,
    headers: { "content-type": "application/json", "x-request-id": "req-4" },
  });
  const err = await readApiError(res);
  assert.deepEqual(err, { error: "nope", kind: "authorization", requestId: "req-4" });
});

test("readApiError survives a non-JSON body", async () => {
  const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
  const err = await readApiError(res);
  assert.equal(err.kind, "infrastructure");
  assert.equal(err.error, OPAQUE_MESSAGE);
});

test("a thrown error carrying a JSON body recovers its kind", () => {
  // What `useObject` hands back for a non-OK response: the raw body as a message.
  const err = apiErrorFromThrown(
    new Error(
      JSON.stringify({
        error: "daily token budget exhausted; resets at 00:00 UTC",
        kind: "rate_limit",
        requestId: "req-5",
      }),
    ),
  );
  assert.equal(err.kind, "rate_limit");
  assert.equal(err.requestId, "req-5");
  assert.match(err.error, /resets at/);
});

test("a thrown error with a plain message is shown but not classified", () => {
  const err = apiErrorFromThrown(new Error("Failed to fetch"));
  assert.equal(err.kind, "unknown");
  assert.equal(err.error, "Failed to fetch");
  // Unknown is still actionable: the message is worth showing, it just gets no
  // invented next step.
  const shown = presentError(err);
  assert.equal(shown.message, "Failed to fetch");
  assert.equal(shown.hint, undefined);
});

test("a JSON body with a message but no kind keeps the message", () => {
  const err = apiErrorFromThrown(new Error(JSON.stringify({ error: "no panels" })));
  assert.equal(err.kind, "unknown");
  assert.equal(err.error, "no panels");
});

test("a thrown non-error is opaque", () => {
  assert.equal(apiErrorFromThrown(undefined).kind, "infrastructure");
  assert.equal(apiErrorFromThrown(new Error("")).kind, "infrastructure");
  assert.equal(apiErrorFromThrown("a string").error, OPAQUE_MESSAGE);
});
