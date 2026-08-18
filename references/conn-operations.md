# Connection Operations Reference

CLI: `node src/cli/conn.js <command> '<json>'`

## What a Connection is (read this first)

A **Connection** is a third-party app or account — mail, chat, calendar, docs, a tracker, any external SaaS/API — that an owner has **authorized directly to you** through cws-connect. It is this platform's answer to "act on an external service": you do **not** install packages, run MCP servers, configure SMTP, drive a browser, or hold credentials in `.env`. You pick an action from the app's catalog and `conn.invoke` it; the token is handled for you — you never hardcode a provider URL or craft a raw HTTP request.

**One universal flow works for every app — you never pre-learn a specific provider:**

1. **`conn.list`** — which apps/accounts are authorized to you right now (each entry pairs an `application` with a `connectionId` + `status`).
2. **`conn.catalog {app}`** (or `conn.app_actions {applicationId}`) — the app's **action catalog**: every action it exposes, each carrying an `input_schema` (JSON Schema) that describes that action's parameters.
3. **`conn.invoke {app, action, params}`** — run the chosen action with `params` shaped by its `input_schema`. Authorization and token injection happen server-side.

Because you read the catalog and its `input_schema` **at call time**, the same three verbs drive *any* connected app. What differs per app is only the action names and their `input_schema` — which you **discover, never hardcode** — so a newly-added provider needs zero changes here.

**When the app you need isn't in `conn.list`:** it simply isn't authorized to you yet. Tell the owner and ask them to connect/authorize it — do not fall back to a non-platform workaround (installing something, SMTP, scraping, etc.).

**Two credential modes, one flow — and the flow is identical for both.** `conn.invoke` splits on the connection's credential mode internally, so you use the exact same command and get the exact same result shape either way: *direct* — the token is cached locally and `conn.invoke` assembles the request from the catalog and calls the provider **from your own egress**; *proxy* — cws-connect calls the provider server-side and injects the token for you. You never choose the mode, hold a URL, or craft a raw request. Prefer the cache-aware verbs (`conn.invoke` / `conn.catalog`), which resolve the connection and action for you. See "Credential Modes" and "Capability Cache & Call Chain" below for the mechanics.

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
Acquire credential for a connection. Returns `credential_mode` plus:
- **direct**: `access_token`, `token_type`, `expires_at`, `toolkits[]`
- **proxy**: `proxy_ref`, `proxy_endpoint`, `toolkits[]`

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

Both modes are driven by the **same** `conn.invoke {app, action, params}` — it splits internally, so you never select a mode or change how you call.

| Mode | Where the token lives | How `conn.invoke` runs the call |
|------|-----------------------|---------------------------------|
| **direct** | Real `access_token` cached locally (`connect/credentials/<id>.json`, `0600`) | Assembles the request from the catalog's `url_template` + params, injects the local token, and calls the provider **from this host's egress**. Refreshes the token proactively when it carries an `expires_at` that is near/expired, and reactively once on a provider 401 (all tokens); a missing local cache is re-acquired first rather than downgraded to proxy. |
| **proxy** | Never leaves cws-connect | Forwards to the server-side execute endpoint; cws-connect resolves the action, injects the token, and calls the provider. |

Request assembly for direct mode is **code-driven from the catalog** — the action name must resolve in the local catalog and the URL can only be that action's `url_template` expanded with schema-checked params. A free-form provider URL is never accepted from the caller.

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
   runs the action, splitting on credential mode: **direct** → assemble from the
   local catalog's `url_template` and call the provider from this host (injecting
   the locally-cached token, refreshed on near-expiry / 401); **proxy** → the
   server-side execute endpoint (`connection_agents` re-checked there). Same
   command and result shape for both. On an action/schema-shaped error it
   invalidates the cached catalog once so the next `conn.catalog` refetches.
2. **`conn.catalog {app|applicationId}`** — returns the cached action catalog for
   discovery, filling from `conn.app_actions` on a miss / TTL-expiry (24h) /
   `{refresh:true}`. Read this to pick an `action` + build `params` from its
   `input_schema` before calling `conn.invoke`.
3. **`conn.index {refresh?}`** — inspect the local index (observability).

Invalidation is **TTL + error-triggered** — the app-actions response carries no
version/etag today (see "cws-connect follow-up" below), so there is no
change-detected refresh yet.

> **catalog note:** the catalog now carries a per-action `url_template` (and an
> optional `headers_template`, Authorization excluded). Direct-mode `conn.invoke`
> uses these to assemble the real request locally; proxy-mode resolves the same
> mapping server-side. Either way the mapping comes from the catalog, never from
> a caller-supplied URL. If a cached catalog predates `url_template`, a direct
> `conn.invoke` returns a clear error — run `conn.catalog {refresh:true}`.

## conn.request — raw / custom direct call (escape hatch)

`conn.request` is the **escape hatch** for a provider endpoint that has **no curated action** in the catalog. Instead of picking a named action, you supply the whole HTTP request; the CLI attaches the connection's locally-cached direct-mode token and calls the provider **directly over HTTPS** (same egress as direct `conn.invoke`).

```bash
node src/cli/conn.js conn.request '{"app":"gmail","domain":"gmail.googleapis.com","method":"GET","path":"/gmail/v1/users/me/labels"}'
node src/cli/conn.js conn.request '{"connectionId":"2b0e...","domain":"api.github.com","method":"POST","path":"/repos/o/r/issues","headers":{"Accept":"application/vnd.github+json"},"body":{"title":"hi"}}'
```

Inputs: `app` **or** `connectionId` (required, one of); `domain` (bare host, required); `path` (required); `method` (default `GET`); `headers?`, `query?` (object or string), `body?` (object → JSON, string → verbatim). Returns the provider response as `{ status_code, headers, body }` — the same shape as direct `conn.invoke`, and the injected `Authorization` is **never** echoed back.

**Prefer `conn.invoke` (a curated action) whenever one exists.** A curated action carries an `input_schema`, is validated, and needs no host reasoning from you. Reach for `conn.request` only when the endpoint you need is genuinely absent from `conn.catalog` — a one-off or newly-shipped provider API. If you find yourself calling the same raw endpoint repeatedly, that is a signal to add a curated action to the catalog instead.

**Security (all enforced agent-side — the data plane does not pass through the backend, so nothing downstream can re-check it):**

- **Origin allowlist (the core gate — host + port).** The target's **`(host, port)`** must **exactly** match one of the normalized **origins** (`scheme=https, host, port`) derived from every action's `url_template` in the local (warmed) action catalog — the port defaulting to **443** when a template omits it. There is **no `*.domain` wildcard**, and the port is part of the identity: an allowed host on an off-catalog port (e.g. `api.example.com:8443` when the catalog only warrants `:443`) is **rejected and the token is never attached or sent**. A Gmail connection permits only the specific `googleapis` origins its catalog references. The set extends automatically as connectors/actions are added — nothing is hardcoded. *Caveat:* a real provider host that no curated action references (e.g. `oauth2.googleapis.com` for a typical Gmail catalog) is **not** allowed; add a catalog action that references it to open it.
- **Freshness fail-closed.** The allowlist is only as trustworthy as the catalog it is derived from. If the local catalog is **missing or stale** (including a cache record with no `fetchedAt`), `conn.request` **refuses** and asks you to run `conn.catalog {refresh:true}` first — rather than authorizing off a stale host set (a host removed upstream must not stay allowed).
- **Direct mode only.** A proxy connection keeps no local token, so `conn.request` refuses it (no downgrade).
- **HTTPS-only.** `domain` is a bare host (optionally `host:port`); the URL is always built as `https://…`. A scheme/path/userinfo in `domain` is rejected.
- **CLI-owned routing (Host).** The CLI owns the `Host` header, derived from the validated target. A caller-supplied `Host` / `:authority` header is **rejected** (not silently forwarded) so a header cannot steer the credential to a different vhost/tenant than the origin the allowlist authorized.
- **Authorization is CLI-owned.** A caller `authorization` header (any case) is dropped and the connection's auth is applied last, so the caller can never override or read the token.
- **No cross-domain redirect follow.** A 3xx is returned to you as-is rather than auto-followed (auto-following would forward the `Authorization` header to the redirect target and could leak the token). Re-issue against the (allowlisted) target yourself if appropriate.
- **DNS resolve-validate-and-pin (SSRF + rebind defense).** Before connecting, the target host is resolved to **all** of its addresses; **every** resolved address must be a **public / global-unicast** IP (loopback / private / link-local / CGNAT `100.64/10` / ULA / cloud-metadata are refused — for both IPv4 and IPv6, including v4-mapped v6). One validated address is then **pinned** and the actual TLS connection is made to that pinned IP (SNI + `Host` = the real hostname), so a **DNS-rebind** between validation and connect cannot swing the credential onto an internal address — there is no second, unvalidated lookup. Literal-IP domains are range-checked directly.
- **No token/secret in logs.** The audit line is `method + host + redacted pathname` only — never headers, the **query string**, the fragment, or the body. Query parameters MUST be passed via the dedicated **`query`** field; a `?` or `#` embedded in `path` is **rejected** so a caller secret can never ride in via the path (and thus into a log).

## WS Event Flow

The comm-bridge automatically maintains the index, the action-catalog cache, and (direct-mode) credentials:

| Event | Action |
|-------|--------|
| `connection.authorized` | Upsert into `connections-index.<orgId>.json`, then **refresh that org's index from the authoritative agent-connections list** so `applicationId`/`slug`/`name` are correct immediately — the event payload carries only `connection_id` + `provider` (slug), so a bare upsert alone would leave `applicationId`/`name` null until the next `conn.list`. Also **warm the action-catalog cache** (`action-catalog/{applicationId}.json`, from `/connect/applications/{id}/actions`) for **both proxy and direct** so the app is invokable right after authorize. **direct only** additionally → acquire credential → cache to `runtime/connect/credentials/{id}.json`. Proxy → indexed + catalog warmed, no credential stored. The identity refresh + catalog warm are **best-effort** (a failure never blocks the credential/index path). **Also enqueues a one-line session notice to the agent** (`🔌 [Connection authorized] …`, via the C4 control queue) so the bot learns it can act via `conn.*` right away, instead of only discovering the connection by chance on a later `conn.list`. |
| `connection.revoked` | Remove from index + delete cached credential |
| `connection.disconnected` | Remove from index + delete cached credential |
| `connection.credential_updated` | Upsert index; re-acquire + refresh the credential **iff a local credential file already exists** (the direct-mode marker — this event carries no `credential_mode`). Drops the file if the connection is no longer direct. Proxy connections (no file) are skipped. |
| `connection.reauth_needed` | **Stop calling the dead connection**: delete the cached credential and keep the connection indexed but flagged `status: needs_reauth` (not removed — reauth is recoverable), so `conn.invoke` surfaces an actionable 409 "needs re-authorization" hint instead of a bare 404. Also **best-effort DM the owner** to re-authorize (`sendOwnerReauthDm`; a no-owner / send failure only warns, never blocks the event path). |

Cache location: `components/openmax/runtime/connect/`

### Per-mode agent behavior (direct vs proxy)

What the agent actually does and stores locally, split by credential mode. The
authorization/token boundary is enforced server-side by cws-connect either way;
this table is only the **agent-side** effect.

| Trigger (endpoint) → event | proxy mode — agent does / stores | direct mode — agent does / stores |
|---|---|---|
| **Authorize to agent** → `connection.authorized` | Upsert the org index (`connections-index.<orgId>.json`), then **refresh it from the agent-connections list** so `{applicationId, slug, name, status:active}` is correct despite the sparse event payload, and **warm the action-catalog cache** (`action-catalog/<applicationId>.json`). **No `acquire`, no credential stored** — the token is injected server-side at call time. | Upsert + refresh the org index and **warm the action-catalog cache** (same as proxy), **and** `acquire` the credential and write the real `access_token` to `connect/credentials/<connectionId>.json` (file `0600`, dir `0700`). |
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
| GET | `/connect/agents/me/connections` | conn.list / conn.index --refresh |
| POST | `/connect/connections/{id}/credential` | conn.acquire (also the direct-mode token refresh) |
| POST | `/connect/connections/{id}/proxy` | (proxy-mode internal) |
| GET | `/connect/connections/{id}` | conn.status |
| GET | `/connect/connections/{id}/actions` | conn.actions |
| POST | `/connect/connections/{id}/actions/execute` | conn.invoke (proxy mode) |
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
