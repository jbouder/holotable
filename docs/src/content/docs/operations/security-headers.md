---
title: Security headers
description: Every response carries a security header baseline, and every page a nonce-based Content-Security-Policy.
sidebar:
  order: 5
---

Holotable renders text the model wrote: panel titles, descriptions, SQL. The
rendering path is React, which escapes by default, but a policy the browser
enforces means a rendering bug stops at a console error instead of running a
script. Since [#35](https://github.com/jbouder/holotable/issues/35) every
response carries a header baseline and every HTML page a
`Content-Security-Policy`.

## What is sent

Every response, API routes and assets included, carries these. They are set
in `next.config.ts` from `staticSecurityHeaders` in
`src/lib/security-headers.ts`:

| Header | Value |
| --- | --- |
| `Referrer-Policy` | `strict-origin-when-cross-origin` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=(), payment=()` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, production builds only |

HSTS is left out of `next dev` on purpose: a browser that has seen it for
`localhost` refuses plain `http://localhost` for every other project for a
year.

Every HTML page additionally carries a `Content-Security-Policy`, set per
request by `src/proxy.ts`:

```
default-src 'self';
script-src 'self' 'nonce-…' 'strict-dynamic';
style-src 'self' 'nonce-…';
style-src-attr 'unsafe-inline';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none'
```

In short: scripts run only if they carry this request's nonce or were loaded
by one that does; nothing loads from another origin; the page cannot be
framed. `next dev` adds `'unsafe-eval'` to `script-src` (React rebuilds server
error stacks with `eval`) and `ws: wss:` to `connect-src` (hot reload).
Production has neither.

Two directives are looser than the Next strict-CSP template and deserve a
word. `style-src-attr 'unsafe-inline'` allows `style=""` *attributes*: client
components such as the dashboard grid set `style={{…}}`, React server-renders
those as attributes, and a nonce cannot cover an attribute. `<style>`
*elements* still need the nonce. `img-src` allows `data:` and `blob:` for
canvas exports and inline icons.

## How the nonce works

The proxy mints 128 random bits per request and writes the policy twice: on
the **response**, which the browser enforces, and on the **request** headers
it forwards to the render. Next reads the nonce back out of the request's
`Content-Security-Policy` header and stamps it on every script and style it
emits, including the framework bootstrap and each page's chunks. Setting the
request header also discards any policy a client sent, so a request cannot
choose its own nonce.

One inline script is hand-written: the theme bootstrap in `src/app/layout.tsx`
that sets `data-theme` before first paint. The layout reads the nonce from the
`x-nonce` request header and stamps it itself.

Reading a request header makes every page dynamic, which they already were:
each one reads the session cookie.

**Adding an inline script or style.** It will be blocked unless it carries the
nonce. Read it the way the layout does and pass it as the `nonce` prop, or use
`next/script`, which Next stamps for you. Do not add `'unsafe-inline'` to
`script-src`; a nonce in the same directive makes browsers ignore it anyway.

**Adding a library that injects styles at runtime.** Same rule, and the failure
looks different: nothing errors, the feature simply renders unstyled. A library
that mounts a `<style>` element itself needs to be handed the nonce — the SQL
editor does this through `EditorView.cspNonce`. The nonce comes from
`documentNonce()` (`src/lib/csp-nonce.ts`), which reads it off an element
already in the page rather than taking it as a prop: a client-side navigation
carries a fresh nonce in its response, but the policy in force is still the one
the document arrived with, so only the document's own nonce works. Browsers
blank the attribute after parsing and keep the `nonce` IDL property readable to
same-origin script, which is what that helper reads.

## Rolling out with report-only

Set `CSP_REPORT_ONLY=true` and the same policy is sent as
`Content-Security-Policy-Report-Only`: the browser logs every violation in the
console and blocks nothing. Watch the console across dashboards, the editor
and the theme toggle, then set it back to `false`. In production the flag adds
a startup warning on every boot, because it means the policy is being logged
rather than enforced; see [Startup validation](/operations/startup-validation/).

There is no `report-uri`/`report-to` endpoint yet: violations are visible in
the browser, not collected.

## What is exempt

The proxy runs on every path except `/api`, `/_next/static`, `/_next/image`
and `/favicon.ico`. API responses are JSON, or the SSE stream at
`/api/dashboards/[id]/stream`, which a document policy does not apply to.
Leaving `/api` out keeps the proxy off the stream path entirely; the static
headers are the only thing added to it, and adding headers does not buffer or
transform the body.

Embedding a dashboard in another site's `<iframe>` is blocked by
`frame-ancestors 'none'` and `X-Frame-Options: DENY`. The embed mode tracked
in [#65](https://github.com/jbouder/holotable/issues/65) will relax
`frame-ancestors` for embed responses only.
