---
title: Share links and embedding
description: Read-only links to one dashboard, for a wall display, someone outside the workspace, or an iframe in another tool.
---

A **share link** ([#65](https://github.com/jbouder/holotable/issues/65)) shows
one dashboard, live, to whoever holds it, with no account. It shows nothing
else: no navigation, no editing, no chat, no SQL, no other dashboard.

## Creating and revoking

An editor opens **More actions → Share read-only…** on a dashboard and chooses:

- **Expires after:** 1, 7, 30 or 90 days; 90 is the maximum.
- **Sites that may embed it:** exact origins such as `https://wiki.example.com`.
  With none, the link opens on its own page and cannot be framed.
- **Always show** the dashboard's current window, or follow its own range.

The URL, `/embed/dashboards/<id>?token=hts_…`, is shown **once**. The server
keeps only the token's SHA-256, so it cannot be shown again. **Revoke** stops
the link at once: the next request with it is refused, and its open streams are
closed. Creating and revoking are audited (`share.create`, `share.revoke`), and
everything a link runs is audited as the link (`share:<id>`).

The same through the API, editor role:

| Route | Method | Notes |
| --- | --- | --- |
| `/api/dashboards/[id]/shares` | GET | The dashboard's links, without tokens |
| `/api/dashboards/[id]/shares` | POST | `{ label?, expiresInDays, allowedOrigins?, timeRange? }`; the response carries the token and URL, once |
| `/api/dashboards/[id]/shares/[shareId]` | DELETE | Revoke |

## What a link can and cannot do

- **One dashboard, view only.** A valid token resolves to a share identity that
  `can()` allows `dashboard:view` on that dashboard and nothing besides. The rule
  runs first, so not even the platform-admin bypass widens it. The token is
  accepted only by the embed page and that dashboard's stream; `getIdentity()`
  never reads it, so every other route answers `401`.
- **Checked against its row on every use.** The token is signed with a key
  derived from `SESSION_SECRET`, but a valid signature is not enough. Each use
  loads the share's row and refuses a token that is revoked, expired, for
  another dashboard, or not the one the row was minted with.
- **No SQL leaves the server.** The page is sent each panel's kind, layout,
  options and time field. The SQL, source ids and variable queries stay on the
  server, which runs the stored spec.
- **The server's window.** The link shows its fixed window, or the dashboard's
  own. A `from`/`to` or `var-*` parameter sent with it is ignored, and every
  variable runs at its default.
- **Row-filtered sources refuse.** A link holds no claims, so a panel on a
  [row-filtered source](/admin/row-level-filters/) shows "no access" rather
  than anyone's rows.

## Embedding

Use the URL as an iframe's `src` on one of the origins the link allows. The
proxy reads those origins from the token and sets `frame-ancestors` to exactly
them; the embed path has no `X-Frame-Options`. Every other page keeps
`frame-ancestors 'none'` and `X-Frame-Options: DENY`. The stream authenticates
with the token in its URL, so it does not depend on third-party cookies.

## Treat a link as a credential

Anyone with the URL can view the dashboard until it expires or is revoked.
Holotable's own logs redact `hts_` tokens. A reverse proxy's access log, a
browser's history, or `next dev`'s request log records URLs as they are, so
prefer short expiries and revoke links that are no longer needed. The
management list shows when each link was last used.

---

*Last verified against the code at commit `00ea858` (2026-10-05).*
