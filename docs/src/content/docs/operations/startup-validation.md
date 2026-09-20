---
title: Startup validation
description: The server validates its configuration before it serves a request, and refuses to boot when it is wrong.
sidebar:
  order: 4
---

A misconfigured Holotable used to boot green and fail in front of a user: an
unset `AI_MODEL` surfaced on the first generate request, a missing
`DATABASE_URL` on the first database call, a weak `SESSION_SECRET` never at all
outside production. Since [#39](https://github.com/jbouder/holotable/issues/39)
the server validates the whole environment at startup and reports every problem
at once.

```
Configuration is invalid (2 errors, 1 warning); refusing to start.
  error    SESSION_SECRET: is the placeholder from .env.example, which is public. Generate a unique value with `openssl rand -base64 32`.
  error    AI_MODEL: is not set; every generate request would fail. Set the model id for your AI_PROVIDER (see .env.example).
  warning  TS_METRICS_PASSWORD: is not set; a registered source uses secret_ref "TS_METRICS" and will fail on Test and on every query until it is.
```

## Where it runs

`src/instrumentation.ts` is the Next 16 startup hook; its `register` runs once
per server instance and must complete before the first request is served. It
calls `runStartupChecks` (`src/lib/startup.ts`), prints the report, and exits
the process with status 1 when there is an error. The hook is skipped during
`next build`, which invokes it while prerendering with `NODE_ENV=production`
and no deployment environment; a production build still succeeds with no
`.env` at all.

`npm run config:check` runs the same validation without starting the server
and exits 1 on an error. It reads the same `.env*` files Next does. Use it as
a pre-deploy gate:

```bash
NODE_ENV=production npm run config:check
```

CI runs it against `.env.example` in development mode, so the example file can
never stop a fresh checkout from starting.

## Errors and warnings

An **error** refuses to boot. A **warning** is printed and ignored.

Values that are wrong in every environment are always errors: a URL that does
not parse, an unknown `AI_PROVIDER`, `MIN_REFRESH_INTERVAL_MS` above
`DEFAULT_REFRESH_INTERVAL_MS`, a default time range that ends before it starts,
an `OIDC_SCOPE` without `openid`.

Values that are merely **missing** are errors in production and warnings in
development. `NODE_ENV=production` selects production. An `.env` copied from
`.env.example` therefore starts the dev server with a few warnings, while a
production deployment cannot boot without:

| Variable | Rule |
| --- | --- |
| `DATABASE_URL` | Set, and a `postgresql://` URL. |
| `SESSION_SECRET` | Set, at least 32 characters, not the `.env.example` placeholder, and not a run of a few repeated characters. |
| `AI_MODEL` | Set. |
| `OPENAI_API_KEY` | Set when `AI_PROVIDER` is `openai-compatible` (the default). `OPENAI_BASE_URL` is optional and defaults to OpenAI, but must be an http(s) URL when set. |
| `AI_GATEWAY_API_KEY` | Set when `AI_PROVIDER` is `gateway`. |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_JWKS_URL` | All set: Keycloak is the only way to sign in, and the [client is confidential](/operations/keycloak/). `OIDC_REDIRECT_URI` is derived from the request origin when unset. |

Every numeric knob (`MAX_QUERY_ROWS`, `QUERY_TIMEOUT_SECONDS`, …) must be a
positive integer when set, `DEFAULT_TIME_FROM`/`DEFAULT_TIME_TO` must be
time expressions the server can resolve, and `CSP_REPORT_ONLY` must be `true`
or `false`. Setting it to `true` in production is a **warning** on every boot:
the [Content-Security-Policy](/operations/security-headers/) is then logged,
not enforced. The full list of variables is in
[Configuration](/reference/configuration/).

## Source credentials

After the environment passes, the server reads the `secret_ref` of every live
source from the config store and checks that `<SECRET_REF>_USERNAME` and
`<SECRET_REF>_PASSWORD` exist. A missing pair is a **warning**, never an error:
sources are created at runtime, and a source whose credentials arrive with the
next deploy should not keep the whole server down. The same failure still
surfaces on **Test** and on every query, see
[Source secret references](/operations/secret-references/).

The query waits at most five seconds. If the database is not reachable yet, the
check degrades to a single warning naming the connection error, and the server
starts; every later database call reports its own failure as before.

## Adding a rule

`validateConfig` in `src/lib/config.ts` is pure: it takes an environment map
and returns `ConfigProblem`s, so a rule is a few lines and a test in
`test/config.test.ts`. Shape checks (is this a URL, an enum, a positive
integer) belong in the Zod `EnvSchema`; presence and cross-variable rules
belong in the function body, using `missing()` for values whose severity
depends on the environment and `error()` for values that are wrong everywhere.
Every message names the variable and says what to do.
