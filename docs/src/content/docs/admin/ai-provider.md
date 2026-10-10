---
title: AI provider
description: Selecting a provider and model, and the compatible endpoints that are known to work.
sidebar:
  order: 3
---

The server's provider and model are **environment-selected**. No model
catalog or model-specific data is baked into the code
(`src/lib/ai/provider.ts`).

`AI_MODEL` must be set; **there is no default model**. Choosing the concrete
provider and model is deliberately left to the deployment.

A workspace, and a person, can also set a model in the app, which takes the
place of the environment's for their generations; see
[Models configured in the app](#models-configured-in-the-app).

## Models configured in the app

([#331](https://github.com/jbouder/holotable/issues/331)) Every generation
(dashboard, refine, panel edit, source draft, Explore and dashboard chat)
resolves its model per request, and the first level that is configured wins:

1. **Personal**: the caller's own model, under Settings → Personal model,
   when they have one **and** the workspace allows personal keys.
2. **Workspace**: the workspace's model, under Settings → Workspace model,
   which a source-admin sets.
3. **Environment**: `AI_PROVIDER`, `AI_MODEL` and the rest, below. With
   neither level set, nothing changes.

A level that is configured but broken (its key can no longer be read, see
[rotation](#rotating-session_secret)) is reported as such and generation
refuses with a `503` naming the fix. It never falls through to the next level,
which may be billed to someone else. The settings pages and every prompt box
say which level a generation in that workspace uses.

A configuration is an **OpenAI-compatible** endpoint: base URL, model id, API
key, and the Responses or Chat Completions switch (`OPENAI_API` above). That
covers OpenAI, OpenRouter, Groq, Together, Ollama, vLLM, LM Studio and
anything else that speaks the OpenAI API. Native providers are a follow-up;
the stored row names its provider and keeps its settings as JSON, so adding
one needs no migration. "Test connection" makes one minimal model call with
what is in the form, admitted by the workspace's rate limit and budget like a
generation.

Which level answered is recorded on every generation log row
(`modelConfig`) and on the `dashboard.generate`, `source.draft` and
`dashboard.chat` audit rows, never the key. Rate limits and the
per-workspace budget apply whichever level is used. Both levels are off in
[demo mode](/admin/demo-mode/): the settings sections are not listed and
the routes refuse.

### The API key

- Sealed at rest with AES-256-GCM under a key derived from `SESSION_SECRET`
  by HKDF with its own label (`src/lib/secrets/seal.ts`), the same
  arrangement as the refresh token. A row edited in the database fails to
  open rather than yielding a different key.
- **Write-only.** No route returns it. A settings page shows whether one is
  stored and, for a key of 16 characters or more, its last four characters.
  A blank key field keeps the stored key; "Remove the stored key" clears it,
  for an endpoint that needs none.
- Kept only for the **same origin**. Changing the base URL to a different
  host requires entering the key again, so a stored key cannot be redirected
  to a host its owner never chose.
- Never in a log line, the generation log or an audit row: each key is
  registered with the log's redaction when it is opened or saved, so it is
  removed wherever it appears, whatever its shape.

### Rotating `SESSION_SECRET`

Rotating it makes every stored key unreadable, the same way it ends every
session. Nothing crashes: the settings page says the stored key can no longer
be read, and a generation in that workspace refuses with "This workspace's
model key can no longer be read … A source-admin must enter it again". Re-enter
each key after a rotation.

### The base URL guard

A base URL typed into the app means the server makes requests, carrying a
key, to an address someone chose. So:

- it must be `https`, unless its host is in `AI_BASE_URL_ALLOWLIST`;
- every address the host resolves to must be public: no private (RFC 1918,
  unique-local), loopback, link-local (which holds the cloud metadata
  endpoint), carrier-grade NAT, multicast or reserved address, unless the
  host or the address is allowlisted. This is checked when the URL is saved
  and again on **every connection**, at the moment the socket is opened, so a
  name that changes what it resolves to later (DNS rebinding) is refused too;
- it must not carry a user name or password;
- redirects are not followed, and the client may reach only the configured
  origin.

| Variable | Default | What it does |
|---|---|---|
| `AI_BASE_URL_ALLOWLIST` | empty | Comma-separated host names, addresses and CIDR ranges an in-app base URL may reach although they are not public. A listed **host name** may also use plain `http` and reach whatever it resolves to; a listed **range** admits those addresses for any host. For example `ollama.internal,10.20.0.0/16`. A malformed entry is a startup error. |

The environment's own `OPENAI_BASE_URL` is set by the operator and is not
held to the allowlist.

## `AI_PROVIDER=gateway`

The bare `AI_MODEL` string is routed by the AI SDK Gateway, using
`AI_GATEWAY_API_KEY` from the environment.

## `AI_PROVIDER=openai-compatible`

An OpenAI-compatible endpoint via `OPENAI_BASE_URL` and `OPENAI_API_KEY`.
An empty value is read as unset, for every `OPENAI_*` and `AI_*` variable:
the server drops empty ones at start and the scripts when they load `.env`
([#350](https://github.com/jbouder/holotable/issues/350)), because the
provider SDK reads `OPENAI_BASE_URL` itself and refuses an empty string.

Two OpenAI-compatible surfaces exist and they are **not** interchangeable:

| Surface | Path | Selected by |
| --- | --- | --- |
| Responses API | `/responses` | the default |
| Chat Completions | `/chat/completions` | `OPENAI_API=chat` |

Structured output is requested **non-strict** on both
([#336](https://github.com/jbouder/holotable/issues/336)). OpenAI's strict
mode, the provider default, accepts a schema only when every property is
required, and the dashboard IR has optional fields throughout. Strict, an
OpenAI model refused every generation before it started. The schema is still
sent and the model still follows it; what comes back is validated against the
IR either way, and repaired once if it fails. Endpoints that are not OpenAI
ignore the setting.

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

### When a listed model does not speak the protocol

An aggregator (OpenCode Zen, OpenRouter and the like) puts many vendors' models
behind one base URL and one key, and lists them all at `/models`. Being listed
does **not** mean a model speaks either OpenAI protocol. On Zen, for one, the
Claude and Gemini models answer every request with "Model does not support this
protocol", under `OPENAI_API=chat` and `responses` alike
([#337](https://github.com/jbouder/holotable/issues/337)).

An author then sees, in place of an answer:

> The model provider says the model in AI_MODEL does not support the API this
> server calls it with. Set OPENAI_API to "chat" (Chat Completions) or
> "responses" (Responses API) to match what the provider offers for that
> model, or choose another AI_MODEL.

The server log has the provider's own reply, as `model.request_failed` with
`protocolMismatch: true`. To fix it:

1. Try the other `OPENAI_API` value, and restart.
2. If neither works, the model needs its vendor's own protocol. Use a model
   the aggregator serves over the OpenAI API, point `AI_PROVIDER=gateway` at
   it, or use the vendor's native provider once one is supported.

`npm run eval -- --live --case <name>` with `AI_MODEL` set for that one run is a
quick way to try a model before switching the server to it.

Any other provider failure reaches the author as the status and a pointer to
the server log, never as the provider's reply, which can quote the request or
part of a key.

Every failed model call, on every surface, is one `model.request_failed` line
in the server log, through the log's redaction and with the request's id:
before output starts and after, when the answer breaks partway. The error's
name, message and the provider's status are on it; the request the SDK sent
(prompt, catalog, schema) is not, and nothing is printed to the console raw
([#343](https://github.com/jbouder/holotable/issues/343)). Generation waits for the model's first output before it answers,
so a refusal is an error response (502, or 504 for a
[timeout](#timeouts-and-retries)) rather than an empty answer.

## `AI_PROVIDER=stub`

A recorded model for the end-to-end suite (`src/lib/ai/stub.ts`). It never
calls a network: every request is answered with a fixed spec, chosen by the
output asked for (a dashboard, a panel, a source draft, a chat reply), and
that spec goes through the same schema, SQL guard and server-side execution as
a real model's. A request against a Prometheus source gets a recorded PromQL
dashboard or panel over Holotable's own metrics
(`holotable_query_duration_seconds_*`, `holotable_pollers_active`), which the
compose stack's Prometheus scrapes. It needs no `AI_MODEL` or key. Because it would otherwise let
a deployment that forgot to configure a model boot green, it is a startup
error in production unless `AI_STUB_IN_PRODUCTION=true` is also set; the e2e
suite sets both.

## Operational notes

- Every model-backed route is rate limited per user and budgeted per
  workspace per day ([#18](https://github.com/jbouder/holotable/issues/18));
  see [LLM rate limits and budgets](/admin/llm-limits/).
- Every model request has a deadline and a bounded retry
  ([#22](https://github.com/jbouder/holotable/issues/22)); see
  [Timeouts and retries](#timeouts-and-retries) below. There is no fallback
  model.
- The model a generation will use (the environment's `AI_MODEL`, or a
  [workspace or personal](#models-configured-in-the-app) one) is surfaced
  read-only in the UI so users can see which model produced their specs.

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

## Structured-output repair

Every generation is bound to a schema (a dashboard, a panel, a source draft).
When the finished output fails it, usually over a single field such as a `viz`
that does not exist or a `timeField` that is not a column alias, the author
gets **one** automatic repair instead of losing the turn
([#21](https://github.com/jbouder/holotable/issues/21)):

1. The first attempt streams to the browser as usual, and its response carries
   an `X-Generation-Id` header.
2. When the output fails the schema, the server works out why, against the
   real schema, and holds the original request, the output and the issues for
   five minutes, keyed by that id and by who asked.
3. The browser sees the failure and asks the same route for
   `{ "repairOf": "<id>" }`, showing "Fixing it automatically…".
4. The server takes the held entry. Taking removes it, so there is one repair
   per generation. It authorizes, rate limits and budgets the request again,
   then re-asks the model with the original prompt plus the rejected output
   and the issues, both [fenced as data](/architecture/invariants/). The repair
   streams in place of the first answer.
5. If the repair fails too, that failure is final, and the author sees it with
   Try again.

Nothing the repair acts on comes from the browser except the id: not the
request, not the output, not the issues. A failure that was not about the
output's shape (a provider error, a [timeout](#timeouts-and-retries)) is not
repaired. The held entries live in the server process, which is single-instance
by design, so a restart drops them and the author sees the failure and Try
again, as before.

Each repair is a second row in the generation log with `attempts = 2`, an
audit row with `attempt: 2`, and a count in `holotable_llm_repairs_total`
(`outcome` is `repaired` or `failed`; see [Prometheus
metrics](/operations/metrics/)).

## Measuring generation quality

`npm run eval` runs a fixed corpus of prompts (`evals/corpus/`, one JSON file
each, against a catalog in `evals/catalogs/`) through the same request the
generate route makes, and grades each answer
([#24](https://github.com/jbouder/holotable/issues/24)):

1. it parses against the IR the route binds it to;
2. every panel's query passes its source's guard, SQL or PromQL, as a save
   would re-check it;
3. every SQL `timeField` is a column its query returns, and every PromQL
   `rate()`, `irate()` or `increase()` is over a counter;
4. the case's own expectations hold: which viz kinds are plausible or
   required, which tables or metrics must be read, whether panels are time
   series, and how many panels there are.

A `chat` case (#416) asks one [Explore](/guide/explore/) question instead. Its
recording is the turn's steps, each one's text and tool calls, and replay plays
them back through the real engine, so the guard and the IR decide again what
would have been drawn. It is graded on the panels the server drew (checks 2–4
on each, and a refused panel is a failure), on how many it drew, and on
whether the turn fetched rows in words through `runQuery`.

The prompt is per kind (#387). A case against `evals/catalogs/prometheus-demo.json`,
a Prometheus catalog of Holotable's own metrics, runs the PromQL prompt and is
graded by the PromQL guard; a case against a TimescaleDB catalog runs the SQL
prompt, which is unchanged by PromQL.

| Command | What it does |
|---|---|
| `npm run eval` (`--replay`) | Grades each case's recorded answer in `evals/recordings/`. No provider, no spend, deterministic. CI runs it on every pull request and fails on any case that does not pass. |
| `npm run eval -- --live` | Asks the provider configured in the environment, as the server would, and reports a pass rate. Never fails the run. The `LLM eval (nightly)` workflow runs it with the `AI_MODEL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL` repository secrets and writes the table to the job summary. |
| `npm run eval -- --live --record` | The same, writing each answer to `evals/recordings/` so replay grades it from then on. |

`--case <name>` narrows any of them and `--json <file>` writes the results.
Only a call that finished is recorded; a provider error or a
[timeout](#timeouts-and-retries) fails the case and leaves the old recording
in place. A slow model may need a longer `AI_REQUEST_TIMEOUT_MS` to record a
whole dashboard. The nightly run keeps the default on purpose, because a
model that cannot finish within it fails for authors too.

A recording keeps a digest of the prompt it answered. When the generation
prompt changes, replay still grades the old answer but reports it as stale:
re-record to measure the new prompt. The evals grade a first attempt only; the
[repair](#structured-output-repair) is not part of the score.

---

*Last verified against the code at commit `4e4c5cf` (2026-10-05); in-app models (#331) on 2026-10-07.*
