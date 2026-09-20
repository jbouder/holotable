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

## Operational notes

- There is currently **no rate limiting or budget** on the LLM routes
  ([#18](https://github.com/jbouder/holotable/issues/18)).
- There is **no timeout, retry, or fallback model**
  ([#22](https://github.com/jbouder/holotable/issues/22)); a provider 429 ends
  the author action.
- `AI_MODEL` is also surfaced read-only in the UI so users can see which model
  produced their specs.
