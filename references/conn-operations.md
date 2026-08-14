# Connection Operations Reference

CLI: `node src/cli/conn.js <command> '<json>'`

<!-- Dev note: connection credential-mode internals (local state layout and
     per-event agent behavior) live in docs/design/connect-credential-modes.md —
     intentionally kept out of this agent-facing reference. The agent never
     perceives a connection's credential mode; the token is handled for it. -->

## What a Connection is (read this first)

A **Connection** is a third-party app or account — mail, chat, calendar, docs, a tracker, any external SaaS/API — that an owner has **authorized directly to you** through cws-connect. It is this platform's answer to "act on an external service": you do **not** install packages, run MCP servers, configure SMTP, drive a browser, or hold credentials in `.env`. You pick an action from the app's catalog and `conn.invoke` it; the token is handled for you — you never hardcode a provider URL or craft a raw HTTP request.

**One universal flow works for every app — you never pre-learn a specific provider:**

1. **`conn.list`** — which apps/accounts are authorized to you right now (each entry pairs an `application` with a `connectionId` + `status`).
2. **`conn.catalog {app}`** (or `conn.app_actions {applicationId}`) — the app's **action catalog**: every action it exposes, each carrying an `input_schema` (JSON Schema) that describes that action's parameters.
3. **`conn.invoke {app, action, params}`** — run the chosen action with `params` shaped by its `input_schema`. Authorization/token handling is done for you.

Because you read the catalog and its `input_schema` **at call time**, the same three verbs drive *any* connected app. What differs per app is only the action names and their `input_schema` — which you **discover, never hardcode** — so a newly-added provider needs zero changes here.

**When the app you need isn't in `conn.list`:** it simply isn't authorized to you yet. Tell the owner and ask them to connect/authorize it — do not fall back to a non-platform workaround (installing something, SMTP, scraping, etc.).

**One flow, every connection.** The token is handled for you: `conn.invoke` resolves the connection, runs the action, and returns the provider's response — you never hold a URL or craft a raw HTTP request. Prefer the cache-aware verbs (`conn.invoke` / `conn.catalog`), which resolve the connection and action for you. See "Capability Cache & Call Chain" below for the mechanics.

> The command reference below is app-agnostic: examples use placeholders like `<app>`, `<toolkit-slug>/<action-name>`, and a generic provider URL. Substitute the real values you get from `conn.list` / `conn.catalog` at runtime — never assume a particular provider.

## Commands

### conn.list
List connections available to this agent.

```bash
node src/cli/conn.js conn.list '{}'
```

Self only — cws-core derives the caller's identity from the authenticated
principal, not from any client-supplied parameter (no `agentMemberId` override
exists). Returns array of connections with status, application, owner, scopes.

### conn.acquire
Acquire (or refresh) the credential for a connection. Returns the connection's
credential material and its `toolkits[]`; the token is handled for you and you do
not need to inspect the returned fields to call an action — prefer `conn.invoke`,
which acquires and injects the credential for you.

```bash
node src/cli/conn.js conn.acquire '{"connectionId":"2b0e4f41-..."}'
```

The comm-bridge automatically acquires and caches credentials on `connection.authorized` events. Use this command to manually acquire or refresh.

### conn.actions
Discover the named actions available for a connection's provider. Pair with `conn.invoke` to run one by name. Scoped to the agent's authorization on the connection.

```bash
node src/cli/conn.js conn.actions '{"connectionId":"2b0e4f41-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }`. `input_schema` is a JSON Schema (draft-07 style) describing the raw provider request body forwarded for that action; an empty string means the schema is not published / unknown (do NOT assume an empty body), while an explicit empty-object schema (`{"type":"object","properties":{},"additionalProperties":false}`) means the action takes no request body. `params[]` still lists URL path/query placeholders separately. To run an action, use `conn.invoke {app, action, params}`.

### conn.status
Get connection details: status, owner, application, scopes, expiry.

```bash
node src/cli/conn.js conn.status '{"connectionId":"2b0e4f41-..."}'
```

### conn.app_actions
Discover the **app-keyed action catalog** for an application — every action the app exposes (each with its `input_schema`), **without needing an existing connection**. Unlike `conn.actions` (connection-scoped and gated on the connection-agent authorization boundary), this is capability metadata readable by any org member: use it to see what an app can do before a connection exists, or to build a per-application capability cache shared across that app's connections.

```bash
node src/cli/conn.js conn.app_actions '{"applicationId":"cb4e4f15-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }` (same shape as `conn.actions`). Resolved strictly by `applicationId` — the BFF route keys on the path id and does not accept a slug override, so the requested resource identity always matches the returned catalog.

### conn.request
Call a provider method that has **no predefined action** in the catalog — a
custom passthrough. You supply the HTTP `method` + a **relative**
`path` (+ optional `query`, `body`, non-auth `headers`); the CLI assembles the
URL, injects the credential **host-side** (you never see the token), forwards
the request from this host, and returns `{ status, body, headers }` (a small safe
subset of response headers). Use it only for endpoints `conn.catalog` /
`conn.invoke` don't cover — prefer a named action when one exists.

```bash
node src/cli/conn.js conn.request '{"app":"github","method":"GET","path":"/user/repos","query":{"per_page":10}}'
node src/cli/conn.js conn.request '{"app":"github","method":"POST","path":"/repos/o/r/issues","body":{"title":"Bug"}}'
```

Params: `app` (slug/applicationId) **or** `connectionId`; `method` (GET, POST,
PUT, PATCH, DELETE, HEAD); `path` (relative, leading `/`, may include a query
string — an **absolute URL is rejected**); optional `host` (target a
non-primary but allowlisted host, e.g. `uploads.github.com`), `query` (merged
with any query in `path`), `body` (non-GET), `headers` (non-auth only).

Constraints and security model:
- **Host is restricted to the connector's own API domains.** The allowed hosts
  are **derived from the action catalog** — the origins of every action's
  `url_template` (with `{base_url}`-style placeholders resolved from the
  connection), the connection's own `{base_url}` origin, and an optional small
  per-connector `extra_hosts` list. The target host must be a member of that
  allowlist, else the request is rejected with the list of allowed hosts. This
  locks the token to the connector's own domains — it can **never** be
  auto-attached to a model-chosen foreign host.
- **You cannot set auth.** Caller-supplied `Authorization` / `Cookie` / other
  auth headers are rejected; the real credential is injected host-side via the
  exact same code path as `conn.invoke` (canonical `Authorization: <scheme>
  <token>`, or the connector's `auth_injection` descriptor). The token is never
  logged (audit logs origin + path only) and never returned.
- OAuth tokens are refreshed the same way as `conn.invoke` (proactively near
  expiry, once reactively on a provider 401). A provider error status is passed
  through as-is (returned with that `status`, not thrown).

### conn.cached
List locally cached credentials (metadata only, from WS-event auto-acquire) —
an observability view of which connections have a credential cached locally.

```bash
node src/cli/conn.js conn.cached '{}'
```

Returns `{ count, credentials: [...] }`, one metadata entry per cached connection (no token values).

### conn.clear_cache
Clear cached credentials. Without `connectionId`, clears all.

```bash
node src/cli/conn.js conn.clear_cache '{"connectionId":"2b0e4f41-..."}'
node src/cli/conn.js conn.clear_cache '{}'
```

## Capability Cache & Call Chain (runtime/connect/)

All connect-side local state lives under one subtree, split by its natural key:

```
runtime/connect/
├── connections-index.<orgId>.json       # connection → application, per org
├── action-catalog/<applicationId>.json  # application → capability metadata
└── credentials/<connectionId>.json      # cached credential (handled for you)
```

The connections index is **per-org** (`connections-index.<orgId>.json`): the
comm-bridge runs a WS per enabled org and a connection belongs to one org, so a
multi-org agent connected to the same app in two orgs must not resolve the wrong
org's connection. The `conn.*` capability verbs take an optional `{org}` (default:
the single/default enabled org) and run the lookup **and** the execute call
against that org's index, JWT, and member. The action catalog stays global
(keyed by applicationId) since an app's capabilities are the same across orgs.

- **connections-index** resolves an application → its `connectionId` + `status`
  (your entry point is an app, not a connection).
- **action-catalog** caches the per-application action metadata (`input_schema`
  etc.).
- **credentials/** caches credential material locally when a connection has it;
  the token is handled for you at call time — you never read these files.

### Recommended agent flow (identify → call)

Any bot with this skill gets the flow for free by calling the cache-aware verbs —
it does not need to "know" the sequence:

1. **`conn.invoke {app, action, params}`** — resolves the connection for `app`
   from `connections-index.json` (refreshing from `conn.list` on a miss), runs
   the action, and returns the provider's response. The token is handled for you.
   On an action/schema-shaped error it invalidates the cached catalog once so the
   next `conn.catalog` refetches.
2. **`conn.catalog {app|applicationId}`** — returns the cached action catalog for
   discovery, filling from `conn.app_actions` on a miss / TTL-expiry (24h) /
   `{refresh:true}`. Read this to pick an `action` + build `params` from its
   `input_schema` before calling `conn.invoke`.
3. **`conn.index {refresh?}`** — inspect the local index (observability).

> **Escape hatch — `conn.request`:** when the provider endpoint you need has no
> named action in the catalog, call it via `conn.request {app, method, path, …}`
> (see the command reference above). The host is still fenced to the connector's
> own API domains (derived from the same catalog) and the credential is injected
> host-side — you never supply a URL host or the token. Prefer a named
> `conn.invoke` action whenever one exists.

Invalidation is **TTL + error-triggered** — the app-actions response carries no
version/etag today (see "cws-connect follow-up" below), so there is no
change-detected refresh yet.

> **catalog note:** the catalog carries a per-action `url_template` (and an
> optional `headers_template`, Authorization excluded); the request is assembled
> from that mapping, never from a caller-supplied URL. If a cached catalog
> predates `url_template`, `conn.invoke` returns a clear error — run
> `conn.catalog {refresh:true}`.

## WS Event Flow

The comm-bridge automatically maintains the local index, the action-catalog
cache, and any cached credentials from cws-connect WS events (authorize, revoke,
disconnect, credential update, reauth). On `connection.authorized` it also
enqueues a one-line session notice to you (`🔌 [Connection authorized] …`) so you
can act via `conn.*` right away, instead of discovering the connection by chance
on a later `conn.list`. When a connection's credential goes bad,
`connection.reauth_needed` **flags the connection** and subsequent `conn.*` calls
surface an actionable **409 "needs re-authorization"** hint (the owner is also
DM'd best-effort to re-authorize) — re-authorize the connection and retry.

Cache location: `components/openmax/runtime/connect/`

## BFF Endpoints (via cws-core)

| Method | Path | CLI |
|--------|------|-----|
| GET | `/connect/agents/me/connections` | conn.list / conn.index --refresh |
| POST | `/connect/connections/{id}/credential` | conn.acquire (also the token refresh) |
| POST | `/connect/connections/{id}/proxy` | (internal) |
| GET | `/connect/connections/{id}` | conn.status |
| GET | `/connect/connections/{id}/actions` | conn.actions |
| POST | `/connect/connections/{id}/actions/execute` | conn.invoke |
| GET | `/connect/applications/{id}/actions` | conn.app_actions / conn.catalog |

None of these endpoints accept a client-supplied `agent_member_id` — cws-core
derives the caller's identity from the authenticated principal on every one of
them (security fix, 2026-08-04). The CLI never had a way to target a
connection/action that doesn't belong to the calling agent.

## cws-connect follow-up (optional, non-blocking)

`ListApplicationActionsResponse` returns only `ActionInfo` (`toolkit, action,
method, description, params, input_schema`) — **no version/etag**. `Toolkit.version`
exists in the model but is not surfaced on this endpoint. To enable *precise*
catalog invalidation (refresh only when the catalog actually changed), add a
catalog-level version/etag (and ideally `If-None-Match → 304`). Until then the
agent-side cache relies on TTL + error-triggered refresh.
