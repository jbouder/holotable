---
title: AI provider
description: Selecting a provider and model, and the compatible endpoints that are known to work.
sidebar:
  order: 3
---

The provider and model are **environment-selected**. No model catalog or
model-specific data is baked into the code (`src/lib/ai/provider.ts`).

`AI_MODEL` must be set; **there is no default model**. Choosing the concrete
provider and model is deliberately left to the deployment.

## `AI_PROVIDER=gateway`

The bare `AI_MODEL` string is routed by the AI SDK Gateway, using
`AI_GATEWAY_API_KEY` from the environment.

## `AI_PROVIDER=openai-compatible`

An OpenAI-compatible endpoint via `OPENAI_BASE_URL` and `OPENAI_API_KEY`.

Two OpenAI-compatible surfaces exist and they are **not** interchangeable:

| Surface | Path | Selected by |
| --- | --- | --- |
| Responses API | `/responses` | the default |
| Chat Completions | `/chat/completions` | `OPENAI_API=chat` |

### OpenRouter

```bash
AI_PROVIDER=openai-compatible
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_API_KEY=<your-openrouter-api-key>
AI_MODEL=openai/gpt-4o-mini        # any OpenRouter model slug
```

Leave `OPENAI_API` unset — forcing `chat` breaks OpenRouter.

### OpenCode Zen / Go

```bash
AI_PROVIDER=openai-compatible
OPENAI_API=chat
OPENAI_BASE_URL=https://opencode.ai/zen/go/v1
OPENAI_API_KEY=<your-opencode-api-key>
AI_MODEL=kimi-k2.7-code            # a BARE model id
```

OpenCode uses **bare** model ids, unlike OpenRouter's `vendor/model` slugs — a
prefixed id such as `opencode-go/kimi-k2.7-code` is rejected with
`ModelError: Model ... is not supported`. Query `GET <base-url>/models` for the
exact ids. Only models exposing an OpenAI-compatible `/chat/completions`
interface work via this path.

## `AI_PROVIDER=stub`

A recorded model for the end-to-end suite (`src/lib/ai/stub.ts`). It never
calls a network: every request is answered with a fixed spec, chosen by the
output asked for (a dashboard, a panel, a source draft, a chat reply), and
that spec goes through the same schema, SQL guard and server-side execution as
a real model's. It needs no `AI_MODEL` or key. Because it would otherwise let
a deployment that forgot to configure a model boot green, it is a startup
error in production unless `AI_STUB_IN_PRODUCTION=true` is also set; the e2e
suite sets both.

## Operational notes

- Every model-backed route is rate limited per user and budgeted per
  workspace per day ([#18](https://github.com/jbouder/holotable/issues/18));
  see [LLM rate limits and budgets](/operations/llm-limits/).
- Every model request has a deadline and a bounded retry
  ([#22](https://github.com/jbouder/holotable/issues/22)); see
  [Timeouts and retries](#timeouts-and-retries) below. There is no fallback
  model.
- `AI_MODEL` is also surfaced read-only in the UI so users can see which model
  produced their specs.

## Timeouts and retries

Every request to the provider, from every surface (generate, Explore, panel
edit, source draft, dashboard chat), goes through the same model middleware
(`src/lib/ai/invoke.ts`):

| Variable | Default | What it does |
|---|---|---|
| `AI_REQUEST_TIMEOUT_MS` | `45000` | The deadline for one model request, **retries and waits included**. A provider that hangs, before its first byte or partway through a stream, is cut off here with "The model did not finish within …ms" instead of at the route's 60s `maxDuration`, where the platform would end the response with no error. A value of 60000 or more is a startup warning. |
| `AI_MAX_RETRIES` | `2` | Retries after a transient failure, `0` to `10`. `0` turns retrying off. |

- **What is retried**: whatever the provider marks transient, which is a 408,
  409, 429 or 5xx response, or a dropped connection. A 400, 401, 403 or 404,
  or a schema the model does not support, fails at once.
- **Backoff**: full jitter, a random wait under a ceiling that starts at 500ms
  and doubles per retry, up to 8s. A `retry-after` or `retry-after-ms` header
  from the provider is honored instead.
- **Giving up early**: if the next wait would end past the deadline, the
  request fails immediately with the provider's own error rather than
  sleeping into a timeout.
- **What surfaces**: after the last retry, the provider's own error, not a
  wrapper, so the generation log and audit row record what the provider
  said.
- **Only before output starts**: a stream that breaks after the first chunk
  is not retried. Its partial output has already reached the browser, and a
  second attempt would be a different answer.
- In the dashboard chat, each model step (one per tool call) is its own
  request with its own deadline.
- Every retry and every timeout is logged at `warn`.

---

*Last verified against the code at commit `4e4c5cf` (2026-10-05).*
