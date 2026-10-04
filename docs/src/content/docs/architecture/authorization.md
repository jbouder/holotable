---
title: Authorization model
description: Group-based roles from Keycloak, one decision point, and the single sanctioned bypass.
sidebar:
  order: 2
---

Roles come **exclusively** from the token's `groups` claim (Keycloak group
paths):

```
/workspaces/{workspaceId}/viewer          # read dashboards
/workspaces/{workspaceId}/editor          # create/update/generate dashboards
/workspaces/{workspaceId}/source-admin    # manage sources; delete dashboards
/platform-admins                          # global admin (single sanctioned bypass)
```

## Rules

- **Highest role wins** within a workspace: `viewer < editor < source-admin`.
- **Authorization is never derived from a workspace id in a request body.** The
  workspace is taken from a trusted, already-scoped resource
  (`source.workspaceId`, `dashboard.workspaceId`) or, for list and create
  operations, checked against the identity for the requested workspace.
- **Unknown or malformed groups are ignored** — `parseGroups` fails closed and
  grants no role.

## Action matrix

| Action | Required |
| --- | --- |
| Dashboard list / get | viewer |
| Dashboard create / update / generate | editor |
| Dashboard delete | owner, source-admin, or platform-admin |
| Source CRUD / test / refresh / column exposure | source-admin |
| Source use (list for a picker, browse the exposed catalog) | viewer |
| Workspace AI limits (read) | source-admin |
| Workspace AI limits (change, `workspace:limits`) | platform-admin only; no workspace role grants it |

## One decision point

`can(identity, action, ctx)` in `src/lib/auth/authorize.ts` is the only place
role decisions are made, and the only place the platform-admin bypass applies.
Every route calls `requireIdentity()` then `assertAuthorized(...)`; nothing
computes authorization inline.

The source is re-resolved and re-authorized on **every** execution, including
each poller tick — so revoking access to a source stops in-flight dashboards
from reading it, rather than waiting for a page reload.

## Sessions

A request is authenticated by a signed JWT in the session cookie. Two
verification strategies are selected by environment:

1. **Keycloak-issued tokens** (production): verified against the realm JWKS
   (RS256) with issuer and audience checks. Enabled when `OIDC_JWKS_URL` and
   `OIDC_ISSUER` are configured.
2. **Locally-signed session tokens** (HS256 via `SESSION_SECRET`): used by the
   OIDC callback to mint a first-party session.

Either way, only the validated `sub` and `groups` claims are ever trusted for
authorization. `name` and `email` are carried into the session as display-only
fields for the account menu and **Settings → Account**; `can()` never reads
them, and `test/account.test.ts` holds it to that.

**Settings → Account** describes each role by asking `can()` about a probe
identity that holds exactly that role, so the description cannot drift from
the rule.

The session cookie is `httpOnly`, `Secure` in production, `SameSite=Lax`,
path `/`. It lives as long as the token in it.

### Renewal

When the realm issues a refresh token at sign-in, the session is renewable
(#27):

- The session token lives for half of the refresh token's idle lifetime, at
  most 8 hours: 15 minutes against a default Keycloak realm, whose idle timeout
  is 30 minutes. Without a refresh token it is the 8 hours it always was.
- The refresh token is stored server-side in `sessions`, sealed with
  AES-256-GCM under a key derived from `SESSION_SECRET`. The browser gets only
  a random session id, in a second `httpOnly` cookie
  (`<SESSION_COOKIE_NAME>_renew`) scoped to `/api/auth`, so it travels with
  nothing but sign-in, renewal and sign-out.
- `POST /api/auth/refresh` asks the realm for a fresh token set, verifies the
  new id_token, checks its `sub` is the one that signed in, and mints a new
  session token from **its** groups. A group removed in Keycloak stops working
  at the next renewal.
- The browser renews about a minute before the token expires, and again when a
  tab comes back into view after its renewal was due. A live dashboard whose
  stream is refused renews once and reconnects. When the realm refuses the
  refresh, both cookies are cleared, the row is deleted, and a banner asks the
  person to sign in again.
- A request is still authenticated by verifying the session token alone; the
  table is read only by renewal and sign-out.

### Ending a session early

A session token names its realm session in a `sid` claim (#28). When Keycloak
ends that session — an admin signs the person out, they sign out of another
app on the realm, or the session is revoked — it calls
`POST /api/auth/backchannel-logout` with a signed logout token, and:

- the session is added to an in-memory revocation list that
  `verifySessionToken` checks on every request, so the token stops working
  immediately rather than at its expiry;
- every open dashboard stream opened with that session receives a
  `session-ended` event and is closed, while other viewers of the same
  dashboard carry on;
- its `sessions` rows are deleted, so it cannot be renewed.

A logout token naming only the person (`sub`, no `sid`) ends all of their
sessions. Signing out in Holotable revokes that one session the same way, so a
copy of the cookie stops working too, without signing the person out of their
other devices.

The list lives in the process, which is the supported topology (one instance).
A restart forgets it: a revoked token then verifies again until it expires,
which is at most one session-token lifetime, and it cannot be renewed because
its row is gone.

:::note
OIDC is the only way to authenticate; there is no local or development login
path. Setup for the Keycloak side is in [Keycloak setup](/operations/keycloak/).
:::
