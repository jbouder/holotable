---
title: LLM rate limits and budgets
description: Every model-backed route is rate limited per user and budgeted per workspace, server-side, after authorization.
sidebar:
  order: 6
---

Every model-backed route calls the configured model through the same gate:
generation (`/api/generate`), the source drafter (`/api/sources/generate`),
the dashboard chat (`/api/dashboards/[id]/chat`), Explore (`/api/chat/turn`,
`/api/chat/[id]/messages`), and a model's Test connection, listing and
re-scan (`/api/me/models/test`, `/api/workspaces/[id]/models/test`,
`/api/workspaces/[id]/models/[modelId]/test`, `/api/models/discover`,
`/api/models/detect`). Before
[#18](https://github.com/jbouder/holotable/issues/18) nothing bounded them: an
editor holding a button, or a loop in a browser tab, could spend as fast as
the provider would answer, and a chat turn can take up to six model round
trips. Every one of those routes now passes through `enforceLlmLimits`
(`src/lib/limits/llm.ts`) after `assertAuthorized` and `requireModel`, and a request
over either ceiling is refused with **429** before the model is called.

## Three ceilings

| Limit | Keyed by | Variable | Default |
| --- | --- | --- | --- |
| Rate | workspace **and** user | `LLM_RATE_PER_MINUTE` | `20` requests per minute |
| Budget | workspace | `LLM_DAILY_TOKEN_BUDGET` | `2000000` tokens per UTC day |
| In flight | the server | `LLM_MAX_IN_FLIGHT` | `16` calls at once |

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
stream: a call already running when the budget runs out completes.

Calls admitted together used to see the same headroom and could each spend
it. Admission now **reserves** 8,000 tokens against the day (#496,
`src/lib/limits/reservations.ts`), and the next admission counts the
reservation as spent. The call's real usage settles it, and the difference
goes back. A call that never settles, such as a crash or a client that went
away, has its reservation expire at the model deadline
(`AI_REQUEST_TIMEOUT_MS` plus 15 seconds). A day can still overshoot by what
the running calls spend beyond their reservations.

The **in-flight cap** counts calls admitted and not yet settled, across every
workspace and model. Past it a call is refused as busy with a five-second
`Retry-After`, the same way as a rate limit. A burst of chat turns therefore
waits at this gate instead of reaching the provider at once and failing on
the provider's own rate limit. `holotable_llm_in_flight` is the gauge, and
refusals count as `holotable_llm_requests_total{outcome="busy"}`.

Setting any of the three variables to `0` disables that limit. In production that is a
[startup warning](/operations/startup-validation/) on every boot.

## The 429

The message names the limit that was hit and when it resets, and the response
carries a `Retry-After` header in seconds:

```
429  {"error":"rate limit reached: 20 model requests per minute per user in this workspace; retry after 3s (at 2026-09-20T10:00:03.000Z)"}
429  {"error":"daily token budget reached: 2,000,140 of 2,000,000 tokens used in this workspace today; resets at 2026-09-21T00:00:00.000Z"}
429  {"error":"the model is busy: 16 requests are already running on this server; retry after 5s"}
```

The limiter runs server-side, keyed by the validated identity and a workspace
resolved from a trusted record (the source that owns a generate request, the
dashboard being chatted with), never from the request body. It cannot be
bypassed from the client, and platform admins are not exempt: the limit
protects provider spend, not data.

## Per-workspace overrides

The `workspace_limits` table overrides the environment for one workspace. A
`NULL` column inherits the global value; `0` disables that limit for the
workspace.

A platform admin sets and clears overrides in **Settings → Workspaces**, which
also shows today's usage against the effective limits. Source-admins see their
own workspaces there read-only. Each change is recorded in the
[audit log](/operations/audit-log/) as `workspace.limits.update`. The table can still be edited directly, for example from automation:

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
it. `route` is one of `generate`, `source-draft`, `chat`,
`model-test`, `model-discover`, `model-detect`. The table holds
counters only, never prompts, specs, or output. The Prometheus counter
`holotable_llm_tokens_total` ([#51](https://github.com/jbouder/holotable/issues/51))
counts the same calls in process; see [Prometheus metrics](/operations/metrics/).

```sql
SELECT day, route, model, input_tokens + output_tokens AS tokens, requests
  FROM llm_usage
 WHERE workspace_id = 'acme'
 ORDER BY day DESC, tokens DESC;
```

## Single instance

The rate limiter's buckets, the reservations and the in-flight count are in
process memory: every instance counts on its own, so with N replicas the effective rate is N times the configured one. The
budget is in Postgres and is shared. The store behind the limiter is an
interface (`RateLimitStore`) so a shared implementation can replace the
in-memory one if the app ever goes horizontal; one instance is the supported
topology (see [Scaling and the poller](/architecture/scaling/)).

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
