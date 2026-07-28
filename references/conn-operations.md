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

## WS Event Flow

The comm-bridge automatically handles connection lifecycle events:

| Event | Action |
|-------|--------|
| `connection.authorized` | Acquire credential → cache to `runtime/credentials/{id}.json` |
| `connection.revoked` | Delete cached credential |
| `connection.disconnected` | Delete cached credential |
| `connection.credential_updated` | Re-acquire credential → update cache |
| `connection.reauth_needed` | Log warning (owner must re-authorize) |

Cache location: `components/openmax/runtime/credentials/`

## BFF Endpoints (via cws-core)

| Method | Path | CLI |
|--------|------|-----|
| GET | `/connect/agents/{id}/connections` | conn.list |
| POST | `/connect/connections/{id}/credential?agent_member_id=` | conn.acquire |
| POST | `/connect/connections/{id}/proxy` | conn.proxy |
| GET | `/connect/connections/{id}` | conn.status |
| GET | `/connect/connections/{id}/actions?agent_member_id=` | conn.actions |
| POST | `/connect/connections/{id}/actions/execute` | conn.execute |
| GET | `/connect/applications/{id}/actions` | conn.app_actions |
