# Connection Operations Reference

CLI: `node src/cli/conn.js <command> '<json>'`

## Commands

### conn.list
List connections available to this agent.

```bash
node src/cli/conn.js conn.list '{}'
node src/cli/conn.js conn.list '{"agentMemberId":"019ea70d-..."}'
```

Returns array of connections with status, application, owner, scopes.

### conn.acquire
Acquire credential for a connection. Returns `credential_mode` plus:
- **direct**: `access_token`, `token_type`, `expires_at`, `toolkits[]`
- **proxy**: `proxy_ref`, `proxy_endpoint`, `toolkits[]`

```bash
node src/cli/conn.js conn.acquire '{"connectionId":"2b0e4f41-..."}'
```

The comm-bridge automatically acquires and caches credentials on `connection.authorized` events. Use this command to manually acquire or refresh.

### conn.proxy
Proxy a request through a connection (proxy mode). The agent doesn't see real credentials — cws-connect injects them server-side.

```bash
node src/cli/conn.js conn.proxy '{
  "connectionId": "2b0e4f41-...",
  "method": "GET",
  "url": "https://api.github.com/user/repos",
  "headers": {"Accept": "application/json"}
}'

node src/cli/conn.js conn.proxy '{
  "connectionId": "2b0e4f41-...",
  "method": "POST",
  "url": "https://api.github.com/repos/owner/repo/issues",
  "body": {"title": "Bug report", "body": "..."}
}'
```

Returns `{ status_code, headers, body }`.

### conn.actions
Discover the named actions available for a connection's provider. Pair with `conn.execute` to invoke one by name. Scoped to the agent's authorization on the connection (same boundary as `conn.execute`/`conn.proxy`).

```bash
node src/cli/conn.js conn.actions '{"connectionId":"2b0e4f41-..."}'
```

Returns an array of `{ toolkit, action, method, description, params[], input_schema }`. `input_schema` is a JSON Schema (draft-07 style) describing the raw provider request body forwarded for that action; an empty string means the schema is not published / unknown (do NOT assume an empty body), while an explicit empty-object schema (`{"type":"object","properties":{},"additionalProperties":false}`) means the action takes no request body. `params[]` still lists URL path/query placeholders separately.

### conn.execute
Run a registered named action through a connection. cws-connect resolves the action, injects the token server-side, and calls the provider — the agent needs neither the token nor the provider URL. Action format: `toolkit-slug/action-name`.

```bash
node src/cli/conn.js conn.execute '{
  "connectionId": "2b0e4f41-...",
  "action": "github-repos/list",
  "params": {"visibility": "public"}
}'
```

Returns `{ status_code, body }`.

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

### conn.cached
List locally cached credentials (from WS event auto-acquire).

```bash
node src/cli/conn.js conn.cached '{}'
```

Returns `{ count, credentials: [{ connection_id, credential_mode, has_access_token, has_proxy_ref }] }`.

### conn.clear_cache
Clear cached credentials. Without `connectionId`, clears all.

```bash
node src/cli/conn.js conn.clear_cache '{"connectionId":"2b0e4f41-..."}'
node src/cli/conn.js conn.clear_cache '{}'
```

## Credential Modes

| Mode | Agent gets | Use case |
|------|-----------|----------|
| **direct** | Real access_token | Agent calls external API directly with token |
| **proxy** | proxy_ref token | Agent calls cws-connect proxy; real credentials never leave server |

## Capability Cache & Call Chain (runtime/connect/)

All connect-side local state lives under one subtree, split by its natural key —
**not** by credential mode:

```
runtime/connect/
├── connections-index.<orgId>.json   # connection → application, per org (BOTH modes)
├── action-catalog/<applicationId>.json   # application → capability  (BOTH modes)
└── credentials/<connectionId>.json  # real access_token — DIRECT mode only
```

The connections index is **per-org** (`connections-index.<orgId>.json`): the
comm-bridge runs a WS per enabled org and a connection belongs to one org, so a
multi-org agent connected to the same app in two orgs must not resolve the wrong
org's connection. The `conn.*` capability verbs take an optional `{org}` (default:
the single/default enabled org) and run the lookup **and** the execute call
against that org's index, JWT, and member. The action catalog stays global
(keyed by applicationId) since an app's capabilities are the same across orgs.

- **connections-index** and **action-catalog** are the mode-agnostic *discovery*
  layer, used by proxy and direct alike. The index resolves an application →
  its `connectionId` + `status` (the agent's entry point is an app, not a
  connection); the catalog caches the per-application action metadata
  (`input_schema` etc.).
- **credentials/** only exists for **direct/token-mode** connections (they cache
  a real `access_token`, so files are `0600`). **Proxy-mode connections store
  nothing** — the token is injected server-side by cws-connect at call time, so
  the old per-connection credential blob is not written.

### Recommended agent flow (identify → call)

Any bot with this skill gets the flow for free by calling the cache-aware verbs —
it does not need to "know" the sequence:

1. **`conn.invoke {app, action, params}`** — resolves the connection for `app`
   from `connections-index.json` (refreshing from `conn.list` on a miss), then
   runs the action via the execute endpoint. Authorization + token injection stay
   fully server-side (`connection_agents` is re-checked every call). On an
   action/schema-shaped error it invalidates the cached catalog once so the next
   `conn.catalog` refetches.
2. **`conn.catalog {app|applicationId}`** — returns the cached action catalog for
   discovery, filling from `conn.app_actions` on a miss / TTL-expiry (24h) /
   `{refresh:true}`. Read this to pick an `action` + build `params` from its
   `input_schema` before calling `conn.invoke`.
3. **`conn.index {refresh?}`** — inspect the local index (observability).

Invalidation is **TTL + error-triggered** — the app-actions response carries no
version/etag today (see "cws-connect follow-up" below), so there is no
change-detected refresh yet.

> **direct mode caveat:** the catalog is *sufficient* for proxy/execute (server
> resolves the action → provider URL and injects the token). For direct mode the
> catalog is *reference only* — neither it nor the direct acquire response carries
> the provider base URL, so a direct call also needs provider-endpoint knowledge.

## WS Event Flow

The comm-bridge automatically maintains the index and (direct-mode) credentials:

| Event | Action |
|-------|--------|
| `connection.authorized` | Upsert into `connections-index.json`; **direct only** → acquire credential → cache to `runtime/connect/credentials/{id}.json`. Proxy → indexed only, no credential stored. |
| `connection.revoked` | Remove from index + delete cached credential |
| `connection.disconnected` | Remove from index + delete cached credential |
| `connection.credential_updated` | Upsert index; re-acquire + refresh the credential **iff a local credential file already exists** (the direct-mode marker — this event carries no `credential_mode`). Drops the file if the connection is no longer direct. Proxy connections (no file) are skipped. |
| `connection.reauth_needed` | Log warning (owner must re-authorize) |

Cache location: `components/openmax/runtime/connect/`

### Per-mode agent behavior (direct vs proxy)

What the agent actually does and stores locally, split by credential mode. The
authorization/token boundary is enforced server-side by cws-connect either way;
this table is only the **agent-side** effect.

| Trigger (endpoint) → event | proxy mode — agent does / stores | direct mode — agent does / stores |
|---|---|---|
| **Authorize to agent** → `connection.authorized` | Upsert the org index (`connections-index.<orgId>.json`): `connection → {applicationId, slug, name, status:active}`. **No `acquire`, no credential stored** — the token is injected server-side at call time. | Upsert the org index (same), **and** `acquire` the credential and write the real `access_token` to `connect/credentials/<connectionId>.json` (file `0600`, dir `0700`). |
| **Revoke this agent** (`DELETE /connections/{id}/agents/{memberId}`) → `connection.revoked` | Remove the connection from the org index. No credential file exists, so nothing to delete. | Remove from the org index **and** delete `connect/credentials/<connectionId>.json` (the cached token). |
| **Disconnect the connection** (`POST /connections/{id}/disconnect`) → `connection.disconnected` | Same as revoke: remove from the org index; no credential file. | Same as revoke: remove from the org index **and** delete the cached token file. |
| Token refreshed → `connection.credential_updated` | Nothing (no local file to refresh). | Re-`acquire` and rewrite the cached token **iff** a local credential file already exists; if the connection is no longer direct, drop the stale file. |

Notes:
- **revoke vs disconnect** differ in *meaning* — revoke removes only *this agent's*
  authorization (`connection_agents` binding) while the connection lives on for
  others; disconnect tears down the whole connection for everyone — but the
  agent's **local cleanup is identical** (unindex + delete any cached credential).
- Proxy mode never persists a credential locally, so revoke/disconnect only touch
  the index for it. Direct mode is the only case where a real token file is
  written and later deleted.

## BFF Endpoints (via cws-core)

| Method | Path | CLI |
|--------|------|-----|
| GET | `/connect/agents/{id}/connections` | conn.list / conn.index --refresh |
| POST | `/connect/connections/{id}/credential?agent_member_id=` | conn.acquire |
| POST | `/connect/connections/{id}/proxy` | conn.proxy |
| GET | `/connect/connections/{id}` | conn.status |
| GET | `/connect/connections/{id}/actions?agent_member_id=` | conn.actions |
| POST | `/connect/connections/{id}/actions/execute` | conn.execute / conn.invoke |
| GET | `/connect/applications/{id}/actions` | conn.app_actions / conn.catalog |

## cws-connect follow-up (optional, non-blocking)

`ListApplicationActionsResponse` returns only `ActionInfo` (`toolkit, action,
method, description, params, input_schema`) — **no version/etag**. `Toolkit.version`
exists in the model but is not surfaced on this endpoint. To enable *precise*
catalog invalidation (refresh only when the catalog actually changed), add a
catalog-level version/etag (and ideally `If-None-Match → 304`). Until then the
agent-side cache relies on TTL + error-triggered refresh.
