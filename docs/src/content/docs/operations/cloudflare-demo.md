---
title: Hosted demo on Cloudflare
description: How the public demo runs, what limits it, what it costs, and how to deploy it.
sidebar:
  order: 2
---

The public demo at `https://holotable-demo.vibeproject.workers.dev` is the
[quick-start image](/getting-started/quick-start/) running in a Cloudflare
Container behind a Worker. The source is `deploy/cloudflare/demo/`.

```
browser ──▶ Worker (per-IP limits) ──▶ Durable Object ──▶ Container: holotable:quickstart
```

The Worker is the only public surface. It applies the per-IP limits and serves a
"starting" page during a cold start. Everything else passes through to the one
container, which holds TimescaleDB, the server and the demo jobs.

## It resets on purpose

The container sleeps after 30 minutes without a request, and its disk does not
survive a sleep. The next visit starts a fresh container: a new database, the
seeded dashboards and six hours of backfilled history. Anything a visitor built
is gone. The demo banner says so.

An open live stream counts as a request in flight, so a dashboard tab keeps the
demo awake. A forgotten tab doesn't keep it awake forever. A tab hidden for 5
minutes closes its stream, and reopens it when it's shown again. In demo mode, a
visible tab with no pointer, keyboard, wheel or touch activity for 10 minutes
pauses live updates and offers Resume. So the container sleeps within 40 minutes
of the last visitor walking away. A script can still hold a stream open;
`max_instances: 1` caps what that costs.

A cold start serves a page that refreshes every three seconds until the app
answers. Locally it takes about 10 seconds; Cloudflare adds the image pull on a
new host.

## Limits

Every visitor shares one workspace and gets a new identity per session, so the
limits are layered:

| Layer | Limit | Set in |
| --- | --- | --- |
| Worker, per IP | 60 non-GET `/api/*` requests per minute: queries, generation, edits, chat, sign-in | `wrangler.jsonc`, `WRITE_LIMITER` |
| Worker, per IP | 600 other requests per minute: pages, assets, reads, the live stream | `wrangler.jsonc`, `READ_LIMITER` |
| App, per visitor | 5 model requests per minute | `vars.LLM_RATE_PER_MINUTE` |
| App, whole demo | 300 000 model tokens per UTC day | `vars.LLM_DAILY_TOKEN_BUDGET` |
| Cloudflare | One container, ever | `max_instances: 1` |
| Provider | A credit limit on the API key | Your provider's dashboard |

Over a Worker limit a visitor gets a 429 with `Retry-After`. The Worker limits
are counted per Cloudflare location and are eventually consistent: a brake on
floods and scripts, not exact accounting. The app's per-visitor limit resets
with a new session, so the daily budget is the real ceiling on model spend.
The provider's credit limit is the only cap that holds if everything else
fails; set one.

The demo can never register a data source: demo mode refuses to start with
groups above editor. See [Demo mode](/admin/demo-mode/).

## Cost

At published Workers Paid rates, roughly $5 a month while it mostly sleeps and
$35–60 a month if it never sleeps, on a `standard-1` instance (½ vCPU, 4 GiB).
Memory and disk are billed while the container is awake and CPU only while it's
used, so the range depends on how busy it is.
`max_instances: 1` is the ceiling: more traffic keeps the one container awake,
it never starts a second. Model spend is separate and capped by the budget
above.

## Deploying

`.github/workflows/demo.yml` deploys after CI passes on `main`, because CI
publishes the image it deploys. It pins the commit's own image,
`ghcr.io/jbouder/holotable:sha-<short>-quickstart`. Cloudflare Containers
cannot pull from GHCR, so `wrangler deploy` builds `deploy/cloudflare/demo/Dockerfile`, a one-line `FROM`, and pushes it to the Cloudflare Registry.
After the deploy the workflow runs `npm run smoke`, which waits through the
cold start, signs in, and requires real rows from a seeded panel.

Repository secrets:

| Secret | Required | What it is |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | yes | A token that can deploy Workers with Durable Objects and Containers. The docs site's token may need Containers access added. |
| `CLOUDFLARE_ACCOUNT_ID` | yes | The account the demo deploys to. |
| `DEMO_SESSION_SECRET` | yes | 32+ random characters (`openssl rand -hex 32`). Keeps visitors' sessions valid across a wake. |
| `DEMO_AI_MODEL`, `DEMO_OPENAI_API_KEY` | no | Turn on generation and chat. Without them the demo runs with those off. |
| `DEMO_OPENAI_BASE_URL`, `DEMO_OPENAI_API` | no | The provider endpoint and API style, as in [AI provider](/admin/ai-provider/). |

Until the three required secrets exist, the workflow skips the deploy with a
warning instead of failing. A manual run (`workflow_dispatch`) deploys the
current `quickstart` image.

To route model calls through Cloudflare AI Gateway for logs, caching and its
rate limits, set `DEMO_OPENAI_BASE_URL` to the gateway's provider URL, for
example `https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/openai`. The
provider key still travels in `Authorization`. The app does not send a gateway
token, so the gateway must not require one.

## Rotating a secret

Update the repository secret and re-run the workflow. A rotated
`DEMO_SESSION_SECRET` signs every current visitor out; the next page load
signs them back in as a new visitor. Secrets go up with each deploy from a file
in the runner's temp directory, and secrets left unset keep their previous
value.

## By hand

```bash
cd deploy/cloudflare/demo
npm ci
npm run dev        # wrangler dev, Docker required; put SESSION_SECRET in .dev.vars
DEMO_URL=http://localhost:8787 npm run smoke
```

`wrangler dev` runs the real container locally, built for `linux/amd64`, so
it is slower on Apple Silicon.

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
