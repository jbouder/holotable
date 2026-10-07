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
| Annotations (read on a dashboard) | viewer |
| Annotations (create / delete, `dashboard:update`) | editor |
| Share links (create / revoke, `dashboard:update`) | editor |
| Variable options in the editor (`dashboard:generate`) | editor |
| Service-account API tokens (mint / revoke, `source:manage`) | source-admin |
| Workspace AI limits (read) | source-admin |
| Workspace AI limits (change, `workspace:limits`) | platform-admin only; no workspace role grants it |

## One decision point

`can(identity, action, ctx)` in `src/lib/auth/authorize.ts` is the only place
role decisions are made, and the only place the platform-admin bypass applies.
Every route calls `requireIdentity()` then `assertAuthorized(...)`; nothing
computes authorization inline. The actions it decides are `ACTIONS` in the same
file.

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

Two credentials are not a person's session and never become one. A
service-account API token (`Authorization: Bearer ht_…`, #288) resolves to one
workspace at viewer or editor, and `can()` decides its requests from that role
exactly as for a person; see [Service-account API tokens](/operations/api-tokens/).
A share link (#65) may view one dashboard, through the stream and the embed
page only, and `can()` checks it before anything else, the admin bypass
included; see [Share links](/operations/share-links/).

An MCP client (#149) is a person, but not a session: it sends an access token
the realm minted for a second, public client in `Authorization: Bearer`, and
only `/api/mcp` reads one, verifying it on every request (keys, issuer,
expiry, audience and `azp`, access token not id_token, realm session not
revoked) and parsing its `groups` exactly as a session's. A token minted for
that client is refused as a session cookie; see
[MCP clients](/operations/keycloak/#5-mcp-clients).

Either way, only the validated `sub` and `groups` claims are ever trusted for
authorization. `name` and `email` are carried into the session as display-only
fields for the account menu and **Settings → Account**; `can()` never reads
them, and `test/account.test.ts` holds it to that.

**Settings → Account** describes each role by asking `can()` about a probe
identity that holds exactly that role, so the description cannot drift from
the rule.

A sign-in is bound to the browser that started it (#281,
`src/lib/auth/sign-in.ts`). `/api/auth/login` sets three short-lived cookies: the
OAuth `state`, the OIDC `nonce`, and a PKCE code verifier whose S256 challenge
goes to the realm. The callback deletes all three whatever happens. Before the
code is sent anywhere it needs all three and a matching `state`. It redeems the
code with the verifier, verifies the id_token against the realm's keys only,
and refuses it unless its `nonce` is the cookie's. Someone who has obtained
another person's authorization code therefore cannot paste it into their own
sign-in: the realm refuses it without that person's verifier, and the
id_token would carry that person's nonce.

The session cookie is `httpOnly`, `Secure` in production, `SameSite=Lax`,
path `/`. It lives as long as the token in it.

When it is `Secure`, its name is `__Host-<SESSION_COOKIE_NAME>` (#26), and the
sign-in handshake's cookies are `__Host-` prefixed too. A browser accepts a
`__Host-` cookie only if it was set over HTTPS with `Path=/` and no `Domain`, so
a page on a sibling subdomain can't plant a session or overwrite one.
`SESSION_COOKIE_SECURE=false` (plain HTTP, as in the quick-start image) keeps
the bare name, since the browser would refuse a prefixed cookie without
`Secure`. A session cookie under the old name is ignored after an upgrade, and
its holder signs in again.

### Requests from other origins

`SameSite=Lax` stops a cross-site page from sending a POST with the cookie. It
does not stop a page on a sibling subdomain, which is the same *site*, and it
would stop nothing if the cookie ever became `SameSite=None` for embedding
(#65). So every state-changing request (anything but GET, HEAD and OPTIONS) is
also checked for where it came from, in the `route()` wrapper, before any
handler runs (#25, `src/lib/auth/origin.ts`):

| The request says | Result |
| --- | --- |
| `Sec-Fetch-Site: same-origin` or `none` | Allowed: our own page, or the person acting directly |
| `Origin` is listed in `ALLOWED_ORIGINS` | Allowed |
| `Sec-Fetch-Site: same-site` or `cross-site`, or `Origin: null` | 403 |
| No Fetch Metadata; `Origin` equals the origin the request was addressed to (forwarded host and scheme behind a proxy) | Allowed; any other `Origin` is a 403 |
| Neither header | Allowed. No page sent it (a script, `curl`, the realm's back-channel logout), so it is left to authentication |

A browser sets `Sec-Fetch-Site` and `Origin` itself, and a page cannot forge
either. The check is in the wrapper so that a new route is covered without
anyone adding it, and a test holds every POST, PUT, PATCH and DELETE handler
to going through `route()`.

### Renewal

When the realm issues a refresh token at sign-in, the session is renewable
(#27):

- The session token lives for half of the refresh token's idle lifetime, at
  most 8 hours: 15 minutes against a default Keycloak realm, whose idle timeout
  is 30 minutes. Without a refresh token it is the 8 hours it always was.
- The refresh token is stored server-side in `sessions`, sealed with
  AES-256-GCM under a key derived from `SESSION_SECRET`. The browser gets only
  a random session id, in a second `httpOnly` cookie
  (`<SESSION_COOKIE_NAME>_renew`, or `__Secure-<SESSION_COOKIE_NAME>_renew`
  when `Secure`, since `__Host-` requires `Path=/`) scoped to `/api/auth`, so it travels with
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

An open dashboard stream is also ended when the token it was opened with
expires, and when a re-check every `SSE_REAUTH_INTERVAL_MS` finds the
dashboard gone or no longer viewable (#32). The browser reconnects after
expiry with its renewed session, which is re-authorized from the groups the
realm gives now; see [Streaming and rendering](/concepts/streaming-and-rendering/).

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

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
