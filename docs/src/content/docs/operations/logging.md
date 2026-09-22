---
title: Structured logging
description: The JSON log Holotable writes to stdout — its fields, the request id it echoes to callers, and the redaction pass every payload goes through.
sidebar:
  order: 9
---

Holotable writes one JSON object per line to **stdout**. Every line carries a
level, a timestamp, a message, and — for anything that happened while serving a
request — the id of that request, so a user's bug report can be traced to the
lines that produced it.

Nothing goes to stderr. A log line is an event, not a failure of the process,
and splitting the stream by level only makes a container runtime interleave the
two unpredictably. Filter on `level` instead.

## Configuration

| Variable | Values | Default |
| --- | --- | --- |
| `LOG_LEVEL` | `debug`, `info`, `warn`, `error`, `silent` | `debug` in development, `info` in production |
| `LOG_FORMAT` | `json`, `pretty` | `pretty` in development, `json` in production |

Both are checked at startup. `LOG_LEVEL=silent` or `LOG_FORMAT=pretty` in
production boots with a warning that names what you have given up — a silent
server keeps no record of its own unhandled errors, and `pretty` lines are
written for a terminal, not for an aggregator.

`pretty` is the development format: a clock, a coloured level, the message, and
the fields, with a multi-line report (the startup configuration report is the
one that matters) indented beneath rather than escaped into one line.

```
11:20:12.191 WARN  request.rejected requestId=7821823e-… route=dashboards.list method=GET status=401 durationMs=3
```

The same line in `json`:

```json
{"level":"warn","time":"2026-09-22T11:20:12.191Z","msg":"request.rejected","requestId":"7821823e-…","route":"dashboards.list","method":"GET","status":401,"durationMs":3}
```

## Request ids

Every API route is wrapped by `route()`
([`src/lib/http.ts`](https://github.com/jbouder/holotable/blob/main/src/lib/http.ts)),
which does three things before and after the handler runs:

- enters a request context, so any log line written anywhere beneath the
  handler carries `requestId`, `route`, and — once the request has been
  authenticated and authorized — `workspaceId` and `sub`;
- logs the outcome once, with the status and the duration;
- sets **`x-request-id`** on the response.

An inbound `x-request-id` is reused when it matches `[A-Za-z0-9_.:-]{1,128}`,
so an id assigned by a proxy or a client survives the hop. Anything else is
replaced with a fresh UUID — the value is echoed back in a response header, and
an arbitrary string there is a header-injection vector.

When a user reports an error, ask for the `x-request-id` from the failed
response and grep for it:

```bash
kubectl logs deploy/holotable | jq 'select(.requestId == "7821823e-…")'
```

The 500 response body says only `internal error`; the line with that request id
is the only place the real cause is recorded.

:::note
`x-request-id` is set on API responses. Page documents do not carry one: the
proxy that would have to set it runs outside the Node request context, so the
id would appear on the response and in no log line, which is worse than none.
:::

## Trace correlation

A W3C `traceparent` header on an inbound request is parsed into `traceId` and
`spanId` and added to every line of that request. That covers the hop from an
already-instrumented caller today; when tracing lands
([#50](https://github.com/jbouder/holotable/issues/50)) the exporter becomes
the source of these and header parsing stays the fallback for the
un-instrumented hop.

## Redaction

Every payload passes through a redaction pass before it is serialized
([`src/lib/log.ts`](https://github.com/jbouder/holotable/blob/main/src/lib/log.ts)).
This is not a convention call sites are expected to follow — it runs on
everything.

**Credential shapes inside strings** are scrubbed, wherever they appear —
including inside an error message or a stack trace:

| Input | Logged as |
| --- | --- |
| `postgres://ro:hunter2@db:5432/m` | `postgres://ro:[redacted]@db:5432/m` |
| `host=db password=hunter2` | `host=db password=[redacted]` |
| `Authorization: Bearer abcdef…` | `Authorization=[redacted]` |
| `eyJhbGciOi….eyJzdWIi….sig` | `[redacted]` |
| `sk-livekey000111222333444` | `[redacted]` |

**Secret-shaped keys** are dropped whatever their value looks like:
`password`, `secret`, `*_API_KEY`, `authorization`, `cookie`, `private_key`,
`access_token` / `id_token` / `refresh_token` / `session_token`. `secretRef` is
deliberately exempt — it names the environment-variable family a source draws
its credentials from (`TS_METRICS`), which is exactly what an operator needs.
Bare `token` is not in the list, so the `inputTokens` and `outputTokens` counts
the LLM limits record survive.

**SQL and prompt text is never logged verbatim.** A `sql`, `statement`,
`prompt`, `messages`, or `catalog` field is reduced to a truncated SHA-256 and
a length:

```json
"sql": { "sha256": "560e390dbdd1b3ee", "length": 31 }
```

Two lines carrying the same digest ran the same statement — enough to correlate
a slow query across requests, without keeping the statement or a credential
somebody inlined into it.

Payloads are also bounded: strings are capped at 2,000 characters, arrays at 50
entries, and nesting at 6 levels, so a circular or pathological object produces
a readable line rather than hanging the process.

## Probes

`/api/health`, `/api/ready`, and `/api/metrics` log their successful outcome at
`debug`, because a kubelet and a Prometheus scraper hit them every few seconds
and would otherwise be the entire log. A probe that **fails** still logs at
`warn` or `error` — a draining instance, or a refused scrape, is the part worth
seeing.

## Adding a log line

```ts
import { log } from "@/lib/log";

log.info("poller.tick", { dashboard: id, panels: spec.panels.length, durationMs });
```

No call site threads a logger or a request id; the context is picked up from
the enclosing request automatically. `console.*` is a lint error in `src/`
(`suspicious/noConsole` in `biome.json`) — `scripts/` and `test/` are exempt,
since a CLI's output *is* its interface.
