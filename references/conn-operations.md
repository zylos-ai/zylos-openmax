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

### conn.status
Get connection details: status, owner, application, scopes, expiry.

```bash
node src/cli/conn.js conn.status '{"connectionId":"2b0e4f41-..."}'
```

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
| POST | `/connect/connections/{id}/actions/execute` | (not yet exposed) |
