---
title: Demo mode
description: AUTH_MODE=demo gives every visitor a session with no login, for evaluating Holotable and for public demos.
sidebar:
  order: 1
---

Holotable signs people in through Keycloak, and that does not change. Demo mode
is the one exception. It exists for two cases where a login screen is in the
way: trying Holotable on your own machine, and running a public demo.

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

## What a visitor gets

1. A page request with no session cookie is redirected to `/api/auth/login`.
2. In demo mode that route mints a session on the spot and sends the browser
   back to the page it asked for. There is no login screen.
3. The session is an ordinary first-party session token. It names a fresh
   subject, `demo:<random>`, holds the `DEMO_GROUPS` groups, and lasts eight
   hours.

Every visitor gets their own subject. Preferences, favorites, chat history and
the per-person model rate limit are therefore per visitor. Dashboards belong to
the workspace, so every visitor sees and edits the same ones. That is the point
of a shared demo, and a banner at the top of every page says so. A visitor can
dismiss it, and the dismissal is kept in their browser.

The OIDC callback answers 404 in demo mode. Signing out clears the cookie, and
the next page load mints a new visitor.

## The guards

The exception is in how a session is *created*, never in how one is
*checked*. Session verification, group parsing and the `can()` authorization
check are the same code in both modes. What keeps demo mode fenced is a set of
startup checks. Each is an error, so the server refuses to boot:

| Configuration | Why it is refused |
| --- | --- |
| Any of `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_JWKS_URL` | Demo mode would hand out sessions beside real ones. |
| `DEMO_GROUPS` granting `source-admin` | A visitor could register a source pointing at any host the server can reach. |
| `DEMO_GROUPS` containing `/platform-admins` | A visitor would bypass every workspace check. |
| `DEMO_GROUPS` granting no workspace | Every visitor would see an empty app. |

`SESSION_SECRET`, `DATABASE_URL` and `SOURCE_SECRET_REFS` are still required in
production. `DEMO_GROUPS` set without `AUTH_MODE=demo` is ignored with a
warning.

## Without a model

In demo mode `AI_MODEL` and the provider key are optional. A missing one is a
startup warning, not an error. The seeded dashboards, the live viewer and the
SQL editor need no model. The new-dashboard page, Explore, the panel editor's
natural-language edit and the dashboard chat show a notice naming the variables
to set, instead of sending a request that can only fail. With
`AUTH_MODE=oidc` a missing model is still an error in production.

## Not for auth development

Demo mode is fine for working on dashboards, panels and charts. It is not a way
to develop or test authentication. Anything that touches the session, the
claims or authorization runs against a realm; see
[Keycloak setup](/operations/keycloak/).

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
