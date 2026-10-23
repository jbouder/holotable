---
title: Demo and local mode
description: AUTH_MODE=demo gives every visitor a session with no login, for public demos; AUTH_MODE=local signs in one owner, for running Holotable on your own machine.
sidebar:
  order: 1
---

Holotable signs people in through Keycloak, and that does not change. Two
modes are the exception, one for each case where a login screen is in the way:

- **Demo mode** (`AUTH_MODE=demo`), for running a public demo. Every visitor is
  a stranger, gets a session of their own, and is at most an editor.
- **Local mode** (`AUTH_MODE=local`), for trying Holotable on your own machine.
  Whoever reaches the server is its one owner, and may add sources and upload
  files. The [quick-start image](/getting-started/quick-start/) runs in it.

Both change how a session is *created*, never how one is *checked*. Session
verification, group parsing and the `can()` authorization check are the same
code in every mode. A page request with no session cookie is redirected to
`/api/auth/login`, which in either mode mints an ordinary first-party session
on the spot and sends the browser back to the page it asked for. There is no
login screen. The OIDC callback, session renewal and back-channel logout
answer 404, and the [MCP endpoint](/integrations/mcp/) stays closed. Signing
out clears the cookie, and the next page load mints a new session.

## Demo mode

```bash
AUTH_MODE=demo
DEMO_GROUPS=/workspaces/demo/editor   # the default
```

:::danger
Never run demo mode on an instance that holds a real data source, a real
credential, or anything you would not publish. Anyone who can reach the server
is a member of the `DEMO_GROUPS` workspaces. It sits outside the
[trust model](https://github.com/jbouder/holotable/blob/main/SECURITY.md).
:::

### What a visitor gets

A demo session names a fresh subject, `demo:<random>`, holds the
`DEMO_GROUPS` groups, and lasts eight hours.

Every visitor gets their own subject. Preferences, favorites, chat history and
the per-person model rate limit are therefore per visitor. Dashboards belong to
the workspace, so every visitor sees and edits the same ones. That is the point
of a shared demo, and a banner at the top of every page says so. A visitor can
dismiss it, and the dismissal is kept in their browser.

### The guards

Each is an error, so the server refuses to boot:

| Configuration | Why it is refused |
| --- | --- |
| Any of `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_JWKS_URL`, `OIDC_MCP_CLIENT_ID` | Demo mode would hand out sessions beside real ones. |
| `DEMO_GROUPS` granting `source-admin` | A visitor could register a source pointing at any host the server can reach. |
| `DEMO_GROUPS` containing `/platform-admins` | A visitor would bypass every workspace check. |
| `DEMO_GROUPS` granting no workspace | Every visitor would see an empty app. |

`SESSION_SECRET`, `DATABASE_URL` and `SOURCE_SECRET_REFS` are still required in
production. `DEMO_GROUPS` set without `AUTH_MODE=demo` is ignored with a
warning.

The [hosted demo](/operations/cloudflare-demo/) runs the quick-start image,
whose default is local mode, so it sets `AUTH_MODE=demo` itself, and its
smoke test checks that a visitor is a `demo:` subject with no source-admin
role.

## Local mode

```bash
AUTH_MODE=local
LOCAL_GROUPS=/workspaces/local/source-admin   # the default
```

:::danger
Run local mode only on a machine, and a port, that nobody else can reach.
Everyone who can reach the server is signed in as its owner, with the
`LOCAL_GROUPS` roles: they can see everything in its workspace, register a
source pointing at any host the server can reach, and upload files to it. The
server cannot tell whether it is reachable from elsewhere; publish the port on
`127.0.0.1` alone (`-p 127.0.0.1:3000:3000`) on a shared network. Never give it
a real credential. Like demo mode, it sits outside the
[trust model](https://github.com/jbouder/holotable/blob/main/SECURITY.md).
:::

### What the owner gets

Every local session names the same subject, `local:owner`, shown as **Local
owner** on the account page and in the [audit log](/operations/audit-log/). It
holds the `LOCAL_GROUPS` groups and lasts eight hours; a session that has
expired is replaced without a word on the next page load. Preferences,
favorites and chat history belong to that one subject, so they survive sessions
and restarts as long as the database does (the quick start's data volume).

With the default groups the owner is a source-admin of one workspace, `local`:
they can add sources, [upload files](/admin/duckdb/#uploads), and
manage the workspace's models; its limits they can read but not change. Unlike demo mode, the [models
configured in the app](/admin/models/#models-configured-in-the-app) stay on,
so the owner can add a model and its key on the [Models page](/guide/models/)
instead of restarting with `-e`. A banner at the top of every page says that
everyone who can reach the server is its owner; it can be dismissed, and the
dismissal is kept in the browser.

### A model on your machine

In local mode the server looks for a model already running on the machine:
[Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai), or anything
else that answers the OpenAI-style `GET /models`. No key and no variable is
needed. At boot it asks each endpoint in `LOCAL_MODEL_ENDPOINTS` (by default
Ollama's port 11434 and LM Studio's 1234, on `host.docker.internal` for the
quick-start container and on `localhost` outside one) for its models, and lists
what answered under **Detected on this machine** on the [Models
page](/guide/models/#detected-on-this-machine), with the time of the scan.
Started Ollama after the server? Choose **Re-scan** there.

A model found this way works like a server model: chat, Explore and generation
can use it, with no key. When exactly one endpoint answered and the server has
no model of its own (`AI_MODEL` and `AI_MODELS_FILE` unset), its first model
is the default; when more than one answered, none is, and you pick one in the
model menu, which is remembered for the workspace. From inside the quick-start
container Ollama must listen beyond loopback (`OLLAMA_HOST=0.0.0.0`) for
`host.docker.internal` to reach it; on Linux, also run the container with
`--add-host=host.docker.internal:host-gateway`.

`LOCAL_MODEL_DETECT=off` turns this off; `on` turns it on outside local mode.
The variables, the allowlist they imply and the names detected models get are
under [A model on this machine](/admin/models/#a-model-on-this-machine).

### The guards

Each is an error, so the server refuses to boot:

| Configuration | Why it is refused |
| --- | --- |
| Any of `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_JWKS_URL`, `OIDC_MCP_CLIENT_ID` | Local mode would hand out sessions beside real ones. |
| `LOCAL_GROUPS` containing `/platform-admins` | The settings a platform admin owns are server management, not a local user's concern. |
| `LOCAL_GROUPS` granting no workspace | The owner would see an empty app. |

`source-admin` is allowed: that is the point of the mode. `SESSION_SECRET`,
`DATABASE_URL` and `SOURCE_SECRET_REFS` are still required in production.
`LOCAL_GROUPS` set without `AUTH_MODE=local` is ignored with a warning, as is
`DEMO_GROUPS` under local mode.

## Without a model

In demo and local mode `AI_MODEL` and the provider key are optional. A missing
one is a startup warning, not an error. The seeded dashboards, the live viewer
and the SQL editor need no model. The new-dashboard page, Explore, the panel
editor's natural-language edit and the dashboard chat show a notice naming the
variables to set, instead of sending a request that can only fail. In local
mode the notice also says to start Ollama or LM Studio and re-scan (see [A
model on your machine](#a-model-on-your-machine)). With
`AUTH_MODE=oidc` a missing model is still an error in production.

Only the server's models are used in demo mode: the [models configured in
the app](/admin/models/#models-configured-in-the-app) are off. The
[Models page](/guide/models/) lists the server's models and nothing else, it
has no Add, and every model route refuses a write. A model stored by an
earlier non-demo run is ignored. So a visitor can neither spend someone's
stored key nor point the server at an address of their choosing. The
[model chip](/guide/models/#picking-a-model) still picks among the server's
models when the operator declares more than one in `AI_MODELS_FILE`. Local
mode keeps the models configured in the app, for its one owner.

## Not for auth development

Neither mode is a way to develop or test authentication. They are fine for
working on dashboards, panels and charts. Anything that touches the session,
the claims or authorization runs against a realm; see
[Keycloak setup](/admin/keycloak/).

---

*Last verified against the code at commit `a7a479b` (2026-10-17).*
