# Connect Credential Modes (internal design)

> **Internal / developer doc.** This is deliberately kept OUT of the agent-facing
> skill surface (`SKILL.md`, `references/conn-operations.md`). The agent never
> perceives a connection's credential mode — it just runs operations and the
> token is handled for it. This file records the direct-vs-proxy mechanics for
> maintainers of the openmax connect layer (`src/cli/conn.js`,
> `src/lib/direct-exec.js`, `src/lib/direct-request.js`,
> `src/lib/connection-events.js`).

## The two modes

A cws-connect connection resolves to one of two credential modes. Both are driven
by the **same** `conn.invoke {app, action, params}` — `conn.invoke` splits on the
mode internally (via `resolveCredential` → `chooseExecMode`), so the caller uses
the exact same command and gets the exact same result shape either way.

| Mode | Where the token lives | How `conn.invoke` runs the call |
|------|-----------------------|---------------------------------|
| **direct** | Real `access_token` cached locally (`connect/credentials/<id>.json`, `0600`) | Assembles the request from the catalog's `url_template` + params, injects the local token, and calls the provider **from this host's egress**. Refreshes the token proactively when it carries an `expires_at` that is near/expired, and reactively once on a provider 401 (all tokens); a missing local cache is re-acquired first rather than downgraded to proxy. |
| **proxy** | Never leaves cws-connect | Forwards to the server-side execute endpoint; cws-connect resolves the action, injects the token, and calls the provider. |

Request assembly for direct mode is **code-driven from the catalog** — the action
name must resolve in the local catalog and the URL can only be that action's
`url_template` expanded with schema-checked params. A free-form provider URL is
never accepted from the caller.

`conn.acquire` returns `credential_mode` plus, per mode:
- **direct**: `access_token`, `token_type`, `expires_at`, `toolkits[]`
- **proxy**: `proxy_ref`, `proxy_endpoint`, `toolkits[]`

`conn.cached` metadata carries `credential_mode`, `has_access_token`, and
`has_proxy_ref` per cached entry.

## Local state split by natural key (NOT by mode)

```
runtime/connect/
├── connections-index.<orgId>.json      # connection → application, per org (BOTH modes)
├── action-catalog/<applicationId>.json # application → capability      (BOTH modes)
└── credentials/<connectionId>.json     # real access_token — DIRECT mode only
```

- **connections-index** and **action-catalog** are the mode-agnostic *discovery*
  layer, used by proxy and direct alike.
- **credentials/** only exists for **direct/token-mode** connections (they cache a
  real `access_token`, so files are `0600`). **Proxy-mode connections store
  nothing** — the token is injected server-side by cws-connect at call time.

## `conn.request` (direct-native escape hatch)

`conn.request` is DIRECT-MODE ONLY. It needs a local token to inject and a
catalog-derived host allowlist, neither of which a non-direct connection has.
When the resolved connection is not direct-mode, `conn.request` logs a concise
line (`[conn.request] connection <id> (app <slug>) not direct-mode — skipped`)
and returns a neutral `{ skipped: true, reason: "not-direct" }` — it does NOT
throw and does NOT surface any credential-mode detail to the agent.

## WS event flow (combined, all details)

The comm-bridge automatically maintains the index, the action-catalog cache, and
(direct-mode) credentials from cws-connect WS events:

| Event | Action |
|-------|--------|
| `connection.authorized` | Upsert into `connections-index.<orgId>.json`, then **refresh that org's index from the authoritative agent-connections list** so `applicationId`/`slug`/`name` are correct immediately — the event payload carries only `connection_id` + `provider` (slug), so a bare upsert alone would leave `applicationId`/`name` null until the next `conn.list`. Also **warm the action-catalog cache** (`action-catalog/{applicationId}.json`, from `/connect/applications/{id}/actions`) for **both proxy and direct** so the app is invokable right after authorize. **direct only** additionally → acquire credential → cache to `runtime/connect/credentials/{id}.json`. Proxy → indexed + catalog warmed, no credential stored. The identity refresh + catalog warm are **best-effort** (a failure never blocks the credential/index path). **Also enqueues a one-line session notice to the agent** (`🔌 [Connection authorized] …`, via the C4 control queue) so the bot learns it can act via `conn.*` right away, instead of only discovering the connection by chance on a later `conn.list`. |
| `connection.revoked` | Remove from index + delete cached credential |
| `connection.disconnected` | Remove from index + delete cached credential |
| `connection.credential_updated` | Upsert index; re-acquire + refresh the credential **iff a local credential file already exists** (the direct-mode marker — this event carries no `credential_mode`). Drops the file if the connection is no longer direct. Proxy connections (no file) are skipped. |
| `connection.reauth_needed` | **Stop calling the dead connection**: delete the cached credential and keep the connection indexed but flagged `status: needs_reauth` (not removed — reauth is recoverable), so `conn.invoke` surfaces an actionable 409 "needs re-authorization" hint instead of a bare 404. Also **best-effort DM the owner** to re-authorize (`sendOwnerReauthDm`; a no-owner / send failure only warns, never blocks the event path). |

Cache location: `components/openmax/runtime/connect/`

## Per-mode agent-side behavior (WS events)

What the agent actually does and stores locally, split by credential mode. The
authorization/token boundary is enforced server-side by cws-connect either way;
this table is only the **agent-side** effect.

| Trigger (endpoint) → event | proxy mode — agent does / stores | direct mode — agent does / stores |
|---|---|---|
| **Authorize to agent** → `connection.authorized` | Upsert the org index (`connections-index.<orgId>.json`), then **refresh it from the agent-connections list** so `{applicationId, slug, name, status:active}` is correct despite the sparse event payload, and **warm the action-catalog cache** (`action-catalog/<applicationId>.json`). **No `acquire`, no credential stored** — the token is injected server-side at call time. | Upsert + refresh the org index and **warm the action-catalog cache** (same as proxy), **and** `acquire` the credential and write the real `access_token` to `connect/credentials/<connectionId>.json` (file `0600`, dir `0700`). |
| **Revoke this agent** (`DELETE /connections/{id}/agents/{memberId}`) → `connection.revoked` | Remove the connection from the org index. No credential file exists, so nothing to delete. | Remove from the org index **and** delete `connect/credentials/<connectionId>.json` (the cached token). |
| **Disconnect the connection** (`POST /connections/{id}/disconnect`) → `connection.disconnected` | Same as revoke: remove from the org index; no credential file. | Same as revoke: remove from the org index **and** delete the cached token file. |
| Token refreshed → `connection.credential_updated` | Nothing (no local file to refresh). | Re-`acquire` and rewrite the cached token **iff** a local credential file already exists; if the connection is no longer direct, drop the stale file. |
| Credential dead → `connection.reauth_needed` | Keep indexed but flagged `status: needs_reauth` (no credential file to delete). Best-effort DM the owner to re-authorize. | Delete the cached credential; keep indexed and flagged `status: needs_reauth`. Best-effort DM the owner. Either way `conn.*` then surfaces an actionable 409 "needs re-authorization". |

Notes:
- **revoke vs disconnect** differ in *meaning* — revoke removes only *this agent's*
  authorization (`connection_agents` binding) while the connection lives on for
  others; disconnect tears down the whole connection for everyone — but the
  agent's **local cleanup is identical** (unindex + delete any cached credential).
- Proxy mode never persists a credential locally, so revoke/disconnect only touch
  the index for it. Direct mode is the only case where a real token file is
  written and later deleted.

## BFF endpoint mode labels

Two of the BFF endpoints are proxy-mode internals (kept out of the agent-facing
endpoint table):

| Method | Path | CLI |
|--------|------|-----|
| POST | `/connect/connections/{id}/proxy` | `conn.proxy` (proxy-mode internal) |
| POST | `/connect/connections/{id}/actions/execute` | `conn.invoke` (proxy mode) |
