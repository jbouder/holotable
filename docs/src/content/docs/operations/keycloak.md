---
title: Keycloak setup
description: Configure the OIDC client and the group-membership mapper Holotable needs.
sidebar:
  order: 1
---

Holotable derives all authorization from the `groups` claim of the session
token. Keycloak does **not** include group memberships in tokens by default —
you must add a group-membership mapper.

## 1. Realm, client, groups

1. Create (or reuse) a realm, e.g. `holotable`.
2. Create an OpenID Connect client:
   - Client ID: `holotable`
   - Client authentication: **On** (confidential) → copy the client secret.
   - Valid redirect URIs: `http://localhost:3000/api/auth/callback`
     (add your production origin too).
   - Standard flow: enabled.
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
