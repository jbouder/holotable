---
title: MCP server
description: The tools an agent gets at /api/mcp, what each one may do, and how Claude Code and Claude Desktop connect.
---

Holotable is an MCP server
([#148](https://github.com/jbouder/holotable/issues/148)): an agent such as
Claude Code or Claude Desktop connects to `/api/mcp` and gets the same
capabilities the app has, as typed tools, over the same validated IR and the
same guarded routes. The [Claude Code skill](/integrations/writing-specs-with-claude-code/)
teaches a client how to *write* a spec with no server; this is how a client
*does* things against a running one.

## Connecting

The endpoint authenticates MCP clients with the realm, through a second public
Keycloak client, and tells the client where to sign in itself; the setup is in
[Keycloak setup, "MCP clients"](/admin/keycloak/#5-mcp-clients). With
`OIDC_MCP_CLIENT_ID` set and the `holotable-mcp` client in the realm:

```bash
claude mcp add --transport http holotable https://holotable.example.com/api/mcp \
  --client-id holotable-mcp --callback-port 53280
```

Claude Desktop takes the same values under *Bring your own client*. The first
call opens the realm's sign-in in a browser; the client keeps and refreshes
the tokens. A [service-account token](/integrations/api-tokens/) works too, as
a static `Authorization: Bearer ht_…` header, with that token's single role.

The transport is streamable HTTP in its stateless form: every call carries its
own bearer token, so there is no session id, no server-initiated event stream
(a GET asking for one is a `405`) and each POST is answered with one JSON body.
Nothing to share between instances, nothing to expire.

## The tools

Every tool is a thin façade over a function the HTTP routes already call. It
authorizes the caller's identity with `can()` exactly as the route it mirrors
does, re-authorizes the source on every execution, and records the same
[audit event](/operations/audit-log/) with `via: "mcp"`. A failure — an
argument the schema refuses, a refusal, a statement the guard rejects, a rate
limit — comes back in the result as an error the model can read and act on,
never as a protocol error.

| Tool | Mirrors | Needs | Returns |
| --- | --- | --- | --- |
| `list_sources` | `GET /api/sources` | viewer | The caller's sources: id, name, kind and query language (`sql` or `promql`), table or metric count, catalog health. Never a host, port, database, URL, auth mode or `secret_ref`, whatever the role |
| `describe_source` | `GET /api/sources/[id]/catalog` | viewer | The kind's catalog: for SQL the tables and columns a query may use, with types, hidden columns staying hidden; for Prometheus the metrics with their type, help and labels |
| `validate_sql` | `POST /api/sql/validate` | editor | The guard's verdict on one query, without running it: `ok` (with the PromQL guard's hints), or the exact error. Takes `sql` or `promql`, whichever the source's kind answers |
| `run_query` | `POST /api/query` | editor | Rows from one guarded query under the server's limits, with the server-resolved window (relative expressions such as `now-6h`; the configured default when omitted). SQL is windowed on `timeField`; PromQL is stepped by the server, with `instant` and `minStep` as on a panel. At most 200 rows reach the model, with `rowCount` and `truncated` saying what was cut |
| `list_dashboards` | `GET /api/dashboards` | viewer | The dashboards the caller may view, with a search |
| `get_dashboard` | `GET /api/dashboards/[id]` | viewer | One dashboard with its current spec |
| `save_dashboard` | `POST /api/dashboards`, `PUT /api/dashboards/[id]` | editor | Creates a dashboard from a spec, or saves a new version when `dashboardId` is given. The spec is read as a stored spec (an older `specVersion` is upgraded), every panel's source is resolved and its SQL run through the guard, and the workspace is the one the sources belong to, never an argument |
| `generate_dashboard` | `POST /api/generate` (`dashboard`) | editor | A complete spec from a description, against one source and up to two more of the same workspace |
| `generate_panel` | `POST /api/generate` (`explore`) | editor | One panel from a question against a source |
| `generate_source` | `POST /api/sources/generate` | source-admin | A source draft, of the `kind` asked for when one is: the safe connection config (or a Prometheus URL and auth mode) and a best-effort table or metric catalog, naming a granted `secret_ref` when it needs one. Registering it stays in the app |

The three generation tools use the same model the routes would for the
caller in that workspace (their [personal or the workspace's
model](/admin/ai-provider/#models-configured-in-the-app), else the
server's), count against the workspace's
[model rate limit and daily budget](/admin/llm-limits/) like the routes
do, write the same [generation log](/operations/logging/) row, and return a
spec the IR validated — never data. The routes stream to a browser and leave
the one [repair](/concepts/generating-a-panel/) of an answer that failed the
schema to a follow-up request; a tool call answers once, so it repairs inline,
as a second model call that is admitted, counted and audited on its own.

`tools/list` advertises each tool's arguments as JSON Schema produced from the
same zod schema that validates them, so the two cannot drift; `save_dashboard`
and `generate_dashboard` carry the IR itself. The server hands the client a
short set of instructions at `initialize`: list and describe sources first,
check a query with `validate_sql` or try it with `run_query`, then save; name
the time column in `timeField` and never add a time filter by hand.

### One tool name for both languages

`validate_sql` and `run_query` take either `sql` or `promql` (#389), exactly
one, and the source's kind decides which: a query in the other language is
refused by name, as `source "prom" answers PromQL; this query is SQL`. The
tools kept their names rather than gaining `validate_query` aliases, because a
rename breaks every client's configuration and an alias doubles the list a
model chooses from; the argument descriptions say which field goes with which
kind. `timeField` is SQL's, and `instant` and `minStep` are PromQL's; sending
one with the other language is an argument error.

## What a client cannot do

- Reach anything but `/api/mcp` with its token, or reach `/api/mcp` with a
  session cookie.
- See a connection detail or a credential: `describe_source` is the catalog,
  `generate_source` names a `secret_ref`, and nothing resolves one.
- Run anything but one guarded SELECT or PromQL expression, or run it outside
  the window the server resolved, or past the limits `/api/query` has.
- Create, test or delete a source, mint a token, or manage anything a
  source-admin manages in the app, beyond drafting a source.
- Have the model answer with data. Every generated object is a spec; the rows
  come from `run_query`, through the executor.

## Checking a configuration

An authenticated `GET /api/mcp` answers with the caller's own identity, the
way `/api/me` does:

```bash
curl -sS https://holotable.example.com/api/mcp -H "Authorization: Bearer $TOKEN"
```

`npm test` drives the protocol with the official MCP SDK's client
(`test/mcp-client.test.ts`) and every tool over fakes for the database and the
model (`test/mcp-tools.test.ts`).
