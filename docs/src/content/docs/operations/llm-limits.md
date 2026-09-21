---
title: LLM rate limits and budgets
description: Every model-backed route is rate limited per user and budgeted per workspace, server-side, after authorization.
sidebar:
  order: 6
---

Three routes call the configured model: `/api/generate`,
`/api/sources/generate`, and `/api/dashboards/[id]/chat`. Before
[#18](https://github.com/jbouder/holotable/issues/18) nothing bounded them: an
editor holding a button, or a loop in a browser tab, could spend as fast as
the provider would answer, and a chat turn can take up to six model round
trips. Every one of those routes now passes through `enforceLlmLimits`
(`src/lib/limits/llm.ts`) immediately after `assertAuthorized`, and a request
over either ceiling is refused with **429** before the model is called.

## Two ceilings

| Limit | Keyed by | Variable | Default |
| --- | --- | --- | --- |
| Rate | workspace **and** user | `LLM_RATE_PER_MINUTE` | `20` requests per minute |
| Budget | workspace | `LLM_DAILY_TOKEN_BUDGET` | `2000000` tokens per UTC day |

The **rate limit** is a token bucket (`src/lib/limits/rate.ts`): the bucket
holds `LLM_RATE_PER_MINUTE` tokens and refills continuously at that many per
minute, so a user may burst one minute's allowance and then sustain the rate.
A chat turn costs one token however many steps it takes. Buckets are keyed by
`(workspace, user)`, so one user cannot exhaust a workspace for the others.

The **budget** (`src/lib/limits/budget.ts`) is the sum of input and output
tokens, across every route and user in the workspace, for the current UTC day.
Usage is taken from the AI SDK's `usage` report when each call finishes and
written to the `llm_usage` table; the next request reads the day's total back
before it is admitted. The check is a gate at admission, not a meter on the
stream: a call already running when the budget runs out completes, so a day
can overshoot by at most the calls in flight.

Setting either variable to `0` disables that limit. In production that is a
[startup warning](/operations/startup-validation/) on every boot.

## The 429

The message names the limit that was hit and when it resets, and the response
carries a `Retry-After` header in seconds:

```
429  {"error":"rate limit reached: 20 model requests per minute per user in this workspace; retry after 3s (at 2026-09-20T10:00:03.000Z)"}
429  {"error":"daily token budget reached: 2,000,140 of 2,000,000 tokens used in this workspace today; resets at 2026-09-21T00:00:00.000Z"}
```

The limiter runs server-side, keyed by the validated identity and a workspace
resolved from a trusted record (the source that owns a generate request, the
dashboard being chatted with), never from the request body. It cannot be
bypassed from the client, and platform admins are not exempt: the limit
protects provider spend, not data.

## Per-workspace overrides

The `workspace_limits` table overrides the environment for one workspace. A
`NULL` column inherits the global value; `0` disables that limit for the
workspace. There is no UI for it yet; set it directly:

```sql
INSERT INTO workspace_limits (workspace_id, rate_per_minute, daily_token_budget)
VALUES ('acme', 60, 10000000)
ON CONFLICT (workspace_id) DO UPDATE
  SET rate_per_minute = EXCLUDED.rate_per_minute,
      daily_token_budget = EXCLUDED.daily_token_budget,
      updated_at = now();
```

The row is read on every model request, so a change applies to the next one.

## Usage counters

`llm_usage` holds one row per `(workspace_id, day, route, model)` with
`input_tokens`, `output_tokens`, and `requests`, each finished call adding to
it. `route` is one of `generate`, `source-draft`, `chat`. The table holds
counters only, never prompts, specs, or output, and it is the data the
Prometheus counters in [#51](https://github.com/jbouder/holotable/issues/51)
will read.

```sql
SELECT day, route, model, input_tokens + output_tokens AS tokens, requests
  FROM llm_usage
 WHERE workspace_id = 'acme'
 ORDER BY day DESC, tokens DESC;
```

## Single instance

The rate limiter's buckets are in process memory: every instance counts on its
own, so with N replicas the effective rate is N times the configured one. The
budget is in Postgres and is shared. The store behind the limiter is an
interface (`RateLimitStore`) so a shared implementation can replace the
in-memory one when the app goes horizontal
([M4](https://github.com/jbouder/holotable/milestones)).
