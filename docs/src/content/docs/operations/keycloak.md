---
title: Keycloak setup
description: Configure the OIDC client and the group-membership mapper Holotable needs.
sidebar:
  order: 1
---

Holotable derives all authorization from the `groups` claim of the session
token. Keycloak does **not** include group memberships in tokens by default —
you must add a group-membership mapper.

## The local realm

`docker compose up` starts Keycloak 26 on `http://localhost:8080` and imports
`keycloak/holotable-realm.json`: the `holotable` realm, the `holotable` client
with the settings below, the public `holotable-mcp` client [MCP clients](#5-mcp-clients)
sign in through, the `demo` workspace's three role groups,
`/platform-admins`, and two users: **`demo` / `demo`**, in
`/workspaces/demo/source-admin` and `/platform-admins`, and **`viewer` /
`viewer`**, in `/workspaces/demo/viewer`, which the end-to-end suite uses to
check what a read-only member cannot reach. The client also accepts redirects
to `http://localhost:3107`, the port `npm run e2e` serves the app on. The
Keycloak admin console signs in as `admin` / `admin`. All three are
development credentials and must never reach a real deployment. The rest of this page is what to set up in
a realm of your own.

## 1. Realm, client, groups

1. Create (or reuse) a realm, e.g. `holotable`.
2. Create an OpenID Connect client:
   - Client ID: `holotable`
   - Client authentication: **On** (confidential) → copy the client secret.
   - Valid redirect URIs: `http://localhost:3000/api/auth/callback`
     (add your production origin too).
   - Standard flow: enabled.
   - Advanced → **Proof Key for Code Exchange Code Challenge Method**:
     `S256`. Holotable sends a PKCE challenge on every sign-in; with this set,
     the realm also refuses a code exchange that lacks the verifier.
3. Create the groups that encode roles. Group **paths** must match exactly:

   ```
   /workspaces/{workspaceId}/viewer
   /workspaces/{workspaceId}/editor
   /workspaces/{workspaceId}/source-admin
   /platform-admins
   ```

   For a workspace `acme`: create a top-level group `workspaces`, a child
   `acme`, and children `viewer` / `editor` / `source-admin`. Create a separate
   top-level group `platform-admins` for global admins, then assign users.

## 2. Add the group-membership mapper

The mapper puts full group paths into a `groups` claim.

1. Client → **Client scopes** → `holotable-dedicated` → **Add mapper** →
   *By configuration* → **Group Membership**.
2. Configure:
   - Name: `groups`
   - Token Claim Name: `groups`
   - **Full group path: On** — produces `/workspaces/acme/editor`, which is what
     Holotable parses.
   - Add to ID token: On
   - Add to access token: On
   - Add to userinfo: On
3. Save.

:::danger[Full group path must be On]
With *Full group path: Off*, only the leaf name (`editor`) is emitted and
Holotable cannot map it to a workspace. The user ends up with no roles at all,
because `parseGroups` fails closed.
:::

## 3. Point Holotable at the realm

Set these in `.env` (see `.env.example`):

```bash
OIDC_ISSUER=http://localhost:8080/realms/holotable
OIDC_CLIENT_ID=holotable
OIDC_CLIENT_SECRET=<client secret>
OIDC_JWKS_URL=http://localhost:8080/realms/holotable/protocol/openid-connect/certs
OIDC_GROUPS_CLAIM=groups
OIDC_SCOPE=openid profile email groups
```

- `OIDC_JWKS_URL` enables RS256 verification of Keycloak-issued tokens.
- The `profile` and `email` scopes put `name` and `email` in the id_token. The
  account menu and **Settings → Account** display them; they are never used
  for authorization, and a token without them still signs in.
- `OIDC_ACCOUNT_URL` (optional) is linked from **Settings → Account** so people
  can manage what Keycloak owns. For Keycloak it is the issuer followed by
  `/account`, e.g. `http://localhost:8080/realms/holotable/account`.
- The login flow lives at `/api/auth/login` → Keycloak → `/api/auth/callback`,
  which verifies the token and mints a first-party session cookie.

## 4. Verify the claim

Decode an issued token and confirm it contains:

```json
{
  "sub": "…",
  "groups": ["/workspaces/acme/editor", "/platform-admins"]
}
```

If `groups` is missing or contains bare names rather than paths, revisit step 2.
How those paths become roles is described in
[Authorization model](/architecture/authorization/).

## 5. MCP clients

An MCP client — Claude Code, Claude Desktop — runs outside the browser and
cannot hold the session cookie, so it signs in on its own
([#149](https://github.com/jbouder/holotable/issues/149)): `/api/mcp` answers
an unauthenticated call with `401` and a `WWW-Authenticate` header naming the
server's protected-resource metadata (RFC 9728,
`/.well-known/oauth-protected-resource/api/mcp`), which names the realm as the
authorization server. The client then runs the authorization-code flow with
PKCE in a browser, against a **second, public** realm client, and sends the
access token as `Authorization: Bearer`. Nothing new is minted on the
Holotable side: the token is the realm's, verified against the realm's keys
on every request, and the `groups` it carries go through the same parser
and `can()` as a session's.

1. Create a second OpenID Connect client:
   - Client ID: `holotable-mcp` (any id but the browser client's; the server
     refuses to boot when the two are the same).
   - Client authentication: **Off** (public). There is no secret to give a
     client on someone's laptop, and PKCE binds the code to the client that
     asked for it.
   - Standard flow: enabled. Direct access grants: off.
   - Valid redirect URIs: the loopback addresses the clients listen on.
     Claude Desktop is fixed at `http://127.0.0.1:53280/callback`; Claude Code
     picks a port unless `--callback-port` fixes one, so register
     `http://localhost:<port>/callback` for the port you choose. The local
     realm registers `http://localhost:*` and `http://127.0.0.1:*`, which is
     fine for a development realm and too wide for a real one.
   - Advanced → **Proof Key for Code Exchange Code Challenge Method**: `S256`.
2. Add the same **Group Membership** mapper as in step 2, on this client's
   dedicated scope, with *Full group path* on and *Add to access token* on.
   The access token is what the server reads here, not the id_token.
3. Add an **Audience** mapper (*By configuration* → **Audience**): *Included
   Client Audience* `holotable-mcp`, *Add to access token* on. Keycloak does
   not put a client's own id in its access tokens' `aud` by default, and the
   server requires it.
4. Set `OIDC_MCP_CLIENT_ID=holotable-mcp`. Until it is set, `/api/mcp` and the
   metadata are a `404`; demo mode refuses it like every other `OIDC_*`
   variable.
5. Optionally set the same **Backchannel logout URL** as on the browser client,
   so that a realm session ended in Keycloak ends the MCP session at once
   rather than at the token's expiry. The logout token is accepted for either
   client id.

Then connect a client. Keycloak's dynamic client registration is closed to
anonymous callers by default, so the client is told the id:

```bash
claude mcp add --transport http holotable http://localhost:3000/api/mcp \
  --client-id holotable-mcp --callback-port 53280
```

Claude Desktop takes the same values under *Bring your own client* in its
connector settings. Either client opens the realm's sign-in in a browser the
first time, stores the tokens it is given and refreshes them itself. If a
client does not follow the challenge to the metadata, point it at the realm
directly: `authServerMetadataUrl` in `.mcp.json` is
`<issuer>/.well-known/openid-configuration`.

What the server checks on every request, in order: the signature against
`OIDC_JWKS_URL`, `iss` against `OIDC_ISSUER`, `exp`, `aud` and `azp` against
`OIDC_MCP_CLIENT_ID` (minted *for* the MCP client, not merely addressed to
it), that it is an access token (`typ: Bearer`, no `nonce`: an id_token is
refused), and that its realm session (`sid`) has not been revoked. A token
that fails any of these is a `401` with `error="invalid_token"`, which tells
the client to sign in again. A service-account token
([`ht_…`](/operations/api-tokens/)) is accepted on `/api/mcp` too, by its
prefix, and resolves exactly as it does elsewhere.

A realm token is a credential for `/api/mcp` and nothing else. No other route
reads one: `getIdentity()` knows only the session cookie and `ht_` tokens,
and a token minted for the MCP client put in the session cookie is refused
by `azp` even though the realm's keys verify it. The MCP route in turn reads
no cookie, so a browser page cannot reach it with a session. What the tools do
is on the [MCP server](/operations/mcp/) page. An authenticated `GET /api/mcp`
answers with the caller's own identity, the way `/api/me` does, so a
configuration can be checked end to end:

```bash
curl -sS http://localhost:3000/api/mcp -H "Authorization: Bearer $TOKEN"
```

## Session renewal

Holotable renews a session without a new login while the Keycloak session
behind it is alive. For that the client must be issued refresh tokens, which
is Keycloak's default (**Advanced → Use refresh tokens**: on). Nothing else is
configured on the Holotable side.

The realm's session settings decide the lengths:

- **SSO Session Idle** (default 30 minutes) is the refresh token's lifetime.
  The Holotable session token lives half of it, and the browser renews before
  it runs out, which also keeps the realm session from idling out while a tab
  is open.
- **SSO Session Max** (default 10 hours) is the hard end. Past it the realm
  refuses the renewal, and the person sees a banner asking them to sign in
  again.
- Removing someone from a group takes effect at their next renewal, at most one
  session-token lifetime later.

The refresh token is stored encrypted in the config database and never sent to
the browser. If the client does not issue refresh tokens, sessions last 8 hours
and end there, as before.

## Back-channel logout

So that ending a session in Keycloak ends it in Holotable straight away, set on
the client (**Clients → holotable → Settings → Logout settings**):

- **Backchannel logout URL**: `https://<holotable host>/api/auth/backchannel-logout`.
  Keycloak calls it server to server, so it must be reachable from Keycloak,
  not just from browsers.
- **Backchannel logout session required**: on. The logout token then names the
  realm session (`sid`), and only that session ends. Off, it names only the
  person, and every one of their Holotable sessions ends.
- **Front channel logout**: off. Holotable does not implement it.

The realm in `keycloak/holotable-realm.json` already sets these for local
development, pointing at `http://host.docker.internal:3000/…` (the Compose file
maps that name to the host for the Keycloak container). A realm imported
before this change keeps its old client settings; recreate the container
(`docker compose up -d --force-recreate keycloak`) to import it again.

A logout is checked against the realm's keys, issuer and this client id before
anything happens, and it takes effect at once: the session token stops
verifying, any open dashboard streams for it close, and it cannot be renewed.

---

*Last verified against the code at commit `4e4c5cf` (2026-10-05).*
