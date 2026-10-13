---
title: Models and providers
description: The provider kinds, server models from AI_MODELS_FILE or the AI_* variables, workspace and personal models, how a request's model is resolved, the credentials rules and the base URL guard.
sidebar:
  order: 3
---

Holotable calls one model per request, chosen from a **catalog**
([#437](https://github.com/jbouder/holotable/issues/437)):

- **Server models**, declared by the operator in
  [`AI_MODELS_FILE`](#server-models-ai_models_file), or by the `AI_*`
  variables as the one model named `default`. Read-only in the app.
- **Workspace models**, which a source-admin adds for a workspace, one of
  them (or a server model) its default.
- **Personal models**, which a person adds for themselves, usable only in
  workspaces that allow them.

Each is a [provider kind](#models-configured-in-the-app) and that kind's
settings. No vendor's model list is baked into the code: a model id is
typed, or picked from what the vendor lists. The [Models page](/guide/models/)
shows them all, and the [model chip](/guide/models/#picking-a-model) picks
one per request. There is **no default model**: with neither `AI_MODELS_FILE`
nor `AI_MODEL` set, and no workspace model, generation says what to
configure.

## Models configured in the app

([#331](https://github.com/jbouder/holotable/issues/331)) Every generation
(dashboard, refine, panel edit, source draft, Explore and dashboard chat)
resolves its model per request, and the first level that is configured wins:

1. **Personal**: the caller's own model, on the [Models page](/guide/models/),
   when they have one **and** the workspace allows personal keys.
2. **Workspace**: the workspace's default model, which a source-admin sets
   on the Models page.
3. **Server**: `AI_PROVIDER`, `AI_MODEL` and the rest, below, listed as the
   server model `default` (id `env:default`). With neither level set,
   nothing changes.

Since [#439](https://github.com/jbouder/holotable/issues/439) these are
entries in one **catalog**: a workspace may hold several named models and a
person several of their own (`llm_models`, migration 022), and a
workspace's default is one of its models or a server model.
`GET /api/models?workspace=<id>` lists what the caller may use there, and a
request that names a model by id (the [model chip](/guide/models/#picking-a-model))
gets exactly that one; an id the catalog
does not grant the caller in that workspace (another workspace's, another
person's, a deleted one, a personal one where they are not allowed) is a
`400` that names nothing.

A level that is configured but broken (its key can no longer be read, see
[rotation](#rotating-session_secret)) is reported as such and generation
refuses with a `503` naming the fix. It never falls through to the next level,
which may be billed to someone else. The settings pages and every prompt box
say which level a generation in that workspace uses.

A configuration names a **provider kind** and that kind's settings
([#438](https://github.com/jbouder/holotable/issues/438)). The kinds are a
registry (`src/lib/ai/providers/registry.ts`), one module per kind, so a new
vendor is a new module and needs no migration: the stored row names its
provider and keeps its settings as JSON.

| Kind | What it talks to | Settings beyond the model id | Credentials | Where requests go |
|---|---|---|---|---|
| `openai-compatible` | Any endpoint that speaks the OpenAI API: OpenRouter, Groq, Together, Ollama, vLLM, LM Studio | Base URL; Responses or Chat Completions | API key, optional | The typed base URL, held to the [base URL guard](#the-base-url-guard) |
| `anthropic-compatible` | Any endpoint that speaks Anthropic's Messages API: OpenCode Zen's Claude models, LiteLLM, a proxy ([#592](https://github.com/jbouder/holotable/issues/592)) | Base URL | API key, optional | The typed base URL, held to the [base URL guard](#the-base-url-guard) |
| `openai` | OpenAI | | API key | `api.openai.com` |
| `anthropic` | Anthropic (Claude) | | API key | `api.anthropic.com` |
| `google` | Google Gemini (AI Studio key) | | API key | `generativelanguage.googleapis.com` |
| `gateway` | The Vercel AI Gateway; the model is `provider/model` | | API key | `ai-gateway.vercel.sh` |
| `azure` | Azure OpenAI; the model is the deployment name | Resource name; API version (optional); Responses or Chat Completions | API key | `<resource>.openai.azure.com` |
| `bedrock` | Amazon Bedrock | Region | Access key ID, secret access key, session token (optional) | `bedrock-runtime.<region>.amazonaws.com` |
| `mistral` | Mistral | | API key | `api.mistral.ai` |
| `xai` | xAI (Grok) | | API key | `api.x.ai` |
| `stub` | Recorded answers, no network; for the end-to-end suite | | none | nowhere; refused in production unless `AI_STUB_IN_PRODUCTION=true` |

Only `openai-compatible` and `anthropic-compatible` have a base URL a person
types. Every other kind's
host is the vendor's own, derived at most from a resource name or region
that must be a single DNS label, and every request is held to that origin
with no redirect followed. The credentials and the vendor's URL are always
passed to the vendor's SDK explicitly, so a stored model never falls back
to the server's own `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
`AWS_BEARER_TOKEN_BEDROCK` or `*_BASE_URL`. Credentials from a cloud
identity (Bedrock instance roles, Azure Entra) are not supported. Every kind
but Azure and Bedrock can **list its models**
([#443](https://github.com/jbouder/holotable/issues/443)): the dialog asks
the vendor through the same pinned or guarded fetch, reads the reply under a
4 MiB cap, and offers the ids as suggestions. "Test
connection" makes one minimal model call with what is in the form, admitted
by the workspace's rate limit and budget like a generation.

Which level answered is recorded on every generation log row
(`modelConfig`) and on the `dashboard.generate`, `source.draft` and
`dashboard.chat` audit rows, never the key. Rate limits and the
per-workspace budget apply whichever level is used. Both levels are off in
[demo mode](/admin/demo-mode/): the Models page lists the server's models
only and the routes refuse every write.

### Credentials

- Sealed at rest with AES-256-GCM under a key derived from `SESSION_SECRET`
  by HKDF with its own label (`src/lib/secrets/seal.ts`), the same
  arrangement as the refresh token. A row edited in the database fails to
  open rather than yielding a different key. A lone API key is sealed as the
  key itself, and anything else (a Bedrock key pair) as a JSON object; a row
  sealed before [#438](https://github.com/jbouder/holotable/issues/438)
  reads as an API key, so nothing is re-sealed.
- **Write-only.** No route returns them. A settings page shows whether any
  are stored and, for a first secret of 16 characters or more, its last four
  characters. Blank fields keep the stored credentials; "Remove the stored
  key" clears them, for an endpoint that needs none. A kind with several
  fields takes them all at once.
- Kept only while requests go to the **same origin**. Changing the provider,
  the base URL's host, an Azure resource or an AWS region requires entering
  them again, so stored credentials cannot be redirected to a host their
  owner never chose.
- Never in a log line, the generation log or an audit row: each value is
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

## Server models: `AI_MODELS_FILE`

([#440](https://github.com/jbouder/holotable/issues/440)) To offer more than
one server model, or a vendor the variables below cannot describe, list them
in a JSON file and point `AI_MODELS_FILE` at it:

```json
{
  "models": [
    { "name": "claude", "provider": "anthropic", "model": "claude-sonnet-5-5",
      "credentials": { "apiKey": "ANTHROPIC_API_KEY" }, "default": true },
    { "name": "gpt", "provider": "openai", "model": "gpt-5",
      "credentials": { "apiKey": "OPENAI_API_KEY" } },
    { "name": "local", "provider": "openai-compatible", "model": "llama3",
      "baseUrl": "http://ollama.internal:11434/v1", "api": "chat" }
  ]
}
```

- An entry is a [provider kind](#models-configured-in-the-app)'s settings
  plus `name`, an optional `default` and `credentials`.
- `credentials` maps each secret field to the **name** of an environment
  variable, never its value. The file can sit in a ConfigMap; the keys stay
  in Secrets. A value that is not an `UPPER_SNAKE_CASE` name refuses to boot.
- `name` is 1 to 40 lowercase letters, digits and dashes, and unique. The
  model's id is `env:<name>`.
- At most one entry says `"default": true`. Without one, the default is the
  model the legacy variables describe, else the file's first entry.
- A variable an entry names but the server lacks is a warning in
  development and an error in production. The model stays listed and says
  which variable is missing.
- The operator's `baseUrl` is not held to `AI_BASE_URL_ALLOWLIST`, as
  `OPENAI_BASE_URL` is not. Requests still reach its origin only, and
  redirects are not followed.
- The file is read once at boot; a change takes a restart. `npm run
  config:check` checks it like the server does.

The variables below keep working as one more entry named `default`, listed
after the file's. With only the variables set, nothing changes. In Helm the
file is `ai.models`; see [Kubernetes](/operations/kubernetes/).

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

An author then sees, in place of an answer, and whoever is configuring the model sees under
**Test connection** in the model dialog
([#591](https://github.com/jbouder/holotable/issues/591)):

> The model provider says this model does not support the API it was called
> with. Switch the model's API between Responses and Chat Completions
> (OPENAI_API for the server's own model). If neither works, the provider
> serves this model only over its vendor's own API: choose another model, or
> a provider that speaks that API.

The server log has the provider's own reply, as `model.request_failed` with
`protocolMismatch: true`. To fix it:

1. Try the other API: the **API** field of a model configured in the app, or
   the other `OPENAI_API` value (and restart) for the environment's model.
2. If neither works, the model needs its vendor's own protocol. For a Claude
   model behind an aggregator, use the **Anthropic-compatible** kind with the
   same base URL. For Zen that is `https://opencode.ai/zen/v1` and the bare
   model id (`claude-sonnet-5-5`), in the app or as an `AI_MODELS_FILE` entry
   ([#592](https://github.com/jbouder/holotable/issues/592)). Otherwise use a
   model the aggregator serves over the OpenAI API, or point
   `AI_PROVIDER=gateway` at it.

`npm run eval -- --live --case <name>` with `AI_MODEL` set for that one run, or
`--model <name>` for an `AI_MODELS_FILE` entry, is a quick way to try a model
before switching the server to it.

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
compose stack's Prometheus scrapes. A request against a Loki source gets a
recorded `logs` panel of error lines and an error-rate-by-route panel, both on
the first label the catalog lists at its first value. It needs no `AI_MODEL` or key. Because it would otherwise let
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
| `AI_REQUEST_TIMEOUT_MS` | `90000` | The deadline for one model request, **retries and waits included**. A provider that hangs, before its first byte or partway through a stream, is cut off here with "The model did not finish within …ms" instead of at the route's 120s `maxDuration`, where the platform would end the response with no error. A value of 120000 or more is a startup warning. |
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
2. every panel's query passes its source's guard, SQL, PromQL or LogQL, as a save
   would re-check it;
3. every SQL `timeField` is a column its query returns, and every PromQL
   `rate()`, `irate()` or `increase()` is over a counter;
4. the case's own expectations hold: which viz kinds are plausible or
   required, which tables or metrics must be read, whether panels are time
   series, whether every `logs` panel names `options.level`, and how many
   panels there are.

A `chat` case (#416) asks one [Explore](/guide/explore/) question instead. Its
recording is the turn's steps, each one's text and tool calls, and replay plays
them back through the real engine, so the guard and the IR decide again what
would have been drawn. It is graded on the panels the server drew (checks 2–4
on each, and a refused panel is a failure), on how many it drew, and on
whether the turn fetched rows in words through `runQuery`.

The prompt is per kind (#387). A case against `evals/catalogs/prometheus-demo.json`,
a Prometheus catalog of Holotable's own metrics, runs the PromQL prompt and is
graded by the PromQL guard; a case against a TimescaleDB catalog runs the SQL
prompt, which is unchanged by PromQL. A case against `evals/catalogs/loki-demo.json`,
a Loki catalog of stream labels, runs the LogQL prompt (#564) and is graded by
the LogQL guard.

| Command | What it does |
|---|---|
| `npm run eval` (`--replay`) | Grades each case's recorded answer in `evals/recordings/`. No provider, no spend, deterministic. CI runs it on every pull request and fails on any case that does not pass. |
| `npm run eval -- --live` | Asks the provider configured in the environment, as the server would, and reports a pass rate. Never fails the run. The `LLM eval (nightly)` workflow runs it with the `AI_MODEL`, `OPENAI_API_KEY` and `OPENAI_BASE_URL` repository secrets and writes the table to the job summary. |
| `npm run eval -- --live --record` | The same, writing each answer to `evals/recordings/` so replay grades it from then on. |
| `npm run eval -- --live --model <name>` | Asks the server model of that name instead of the default ([#443](https://github.com/jbouder/holotable/issues/443)): an [`AI_MODELS_FILE`](#server-models-ai_models_file) entry, or `default` for the `AI_*` variables. A recording per provider is one command each. An unknown name exits 1 and lists the names on offer. |

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
