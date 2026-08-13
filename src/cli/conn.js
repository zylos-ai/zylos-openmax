#!/usr/bin/env node

/**
 * Connection CLI — cws-connect operations via cws-core BFF.
 *
 * Usage:
 *   node src/cli/conn.js <command> '<json-params>'
 *   node src/cli/conn.js conn.list     '{}'
 *   node src/cli/conn.js conn.acquire  '{"connectionId":"..."}'
 */

import { get, post, del, patch, apiPath, getForOrg, postForOrg } from '../lib/client.js';
import { loadConfig, enabledOrgs, resolveDefaultOrgId } from '../lib/config.js';
import { listCachedCredentials, clearCachedCredentials, readCredentialCache, saveCredentialCache } from '../lib/credential-cache.js';
import {
  readIndex, replaceIndexFromList, findConnectionByApp, indexPathForOrg,
  readCatalog, writeCatalog, invalidateCatalog, CATALOG_TTL_MS,
} from '../lib/connect-store.js';
import { acquireCredential } from '../lib/connection-events.js';
import { invokeDirect, resolveCredential } from '../lib/direct-exec.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// Operating org for the capability-cache verbs: explicit {org} wins, else the
// default/single enabled org. The index is org-scoped, so every lookup + the
// execute call must run against the same org's file, token, and member.
function resolveOrgId() {
  return params.org || params.orgId || params.org_id || resolveDefaultOrgId();
}

// Security note: this agent's own member_id for an org — the ONLY identity
// the conn.* commands below use for the cws-connect agent_member_id calls.
// There is deliberately no client-supplied override (e.g. params.agentMemberId)
// here: accepting one would let a caller impersonate a different agent's
// identity against cws-connect (a confused-deputy/IDOR risk). cws-core is
// moving to derive this server-side from the authenticated principal too, so
// even if a caller sent an override it would be ignored there as well.
function resolveSelfMemberId(orgId = resolveDefaultOrgId()) {
  const cfg = loadConfig();
  for (const [, org] of Object.entries(cfg.orgs || {})) {
    if (org.org_id === orgId && org.self?.member_id) return org.self.member_id;
  }
  const first = Object.values(cfg.orgs || {})[0];
  return first?.self?.member_id || '';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(s) { return typeof s === 'string' && UUID_RE.test(s); }

// The app_actions / actions endpoints return the catalog either as a bare array
// or wrapped as { actions: [...] } depending on the BFF envelope — normalize.
function actionsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.actions)) return result.actions;
  return [];
}

// Fetch this agent's connections for an org from cws-core and rewrite that org's
// index file (org-scoped: uses the org's JWT and its own index path). The
// endpoint is always "your own" connections now (cws-core derives the caller
// from the authenticated principal, no id in the path) — agentId is accepted
// for call-site compatibility but no longer used to build the URL.
async function refreshIndex(orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  const list = await getForOrg(orgId, apiPath('/connect/agents/me/connections'));
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []), idxPath);
  return readIndex(idxPath);
}

// Resolve an application (slug or applicationId) → its connection entry within an
// org, reading that org's index first. Refreshes from conn.list once when the
// app is missing OR the cached entry lacks an applicationId — the latter happens
// in the window after a connection.authorized event (which may carry only a slug)
// before any conn.list has filled the applicationId. Without that refresh,
// conn.catalog {app} would 400 on a slug-only entry.
async function resolveConnectionForApp(app, orgId, agentId) {
  const idxPath = indexPathForOrg(orgId);
  let entry = findConnectionByApp(app, idxPath);
  if (!entry || !entry.applicationId) {
    await refreshIndex(orgId, agentId);
    entry = findConnectionByApp(app, idxPath);
  }
  return entry;
}

// Return an application's action catalog, reading the cache first and filling it
// via conn.app_actions (org-scoped token) on a miss / TTL-expiry / explicit
// refresh. The catalog file is global (keyed by applicationId) since an app's
// capabilities are the same across orgs.
async function getCatalog(orgId, applicationId, { refresh = false, ttlMs = CATALOG_TTL_MS } = {}) {
  if (!refresh) {
    const cached = readCatalog(applicationId, { ttlMs });
    if (cached) return { ...cached, source: 'cache' };
  }
  const actions = actionsOf(await getForOrg(orgId, apiPath(`/connect/applications/${applicationId}/actions`)));
  const rec = writeCatalog(applicationId, actions);
  return { ...rec, source: 'fetch' };
}

// Heuristic: does an execute error look like a stale/unknown-action or
// input-schema mismatch (vs. an auth/network failure)? Used to decide whether a
// one-shot catalog refresh could help.
function looksLikeActionOrSchemaError(err) {
  if (!err) return false;
  if (err.status === 404) return true;
  if (err.status === 400) {
    return /action|schema|param|unknown|not found|invalid|required/i.test(err.message || '');
  }
  return false;
}

const COMMANDS = {
  // List connections available to this agent.
  // Always uses the agent's own member_id (resolveSelfMemberId) — no
  // client-supplied override; see the security note above resolveSelfMemberId.
  'conn.list': () => {
    const agentId = resolveSelfMemberId();
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return get(apiPath('/connect/agents/me/connections'));
  },

  // Acquire credential for a connection.
  // Returns credential_mode + access_token (direct) or proxy_ref (proxy).
  'conn.acquire': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    if (!resolveSelfMemberId()) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return post(apiPath(`/connect/connections/${connId}/credential`));
  },

  // Proxy a request through a connection.
  // NOTE: proxy-mode only; hidden from the agent surface (help text + reference
  // doc), retained here for proxy connections and future use. Not reachable via
  // conn.invoke (which does direct locally / proxy via conn.execute).
  'conn.proxy': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    return post(apiPath(`/connect/connections/${connId}/proxy`), {
      method: params.method || 'GET',
      url: params.url,
      headers: params.headers,
      body: params.body,
    });
  },

  // Discover the named actions available for a connection (action discovery).
  // Returns [{toolkit, action, method, description, params, input_schema}];
  // pair with conn.execute to invoke one by "toolkit-slug/action-name". cws-core
  // scopes discovery to the caller's own connection-agent authorization
  // boundary (derived server-side), same as conn.execute/conn.proxy.
  'conn.actions': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    if (!resolveSelfMemberId()) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return get(apiPath(`/connect/connections/${connId}/actions`));
  },

  // Execute a registered named action through a connection (proxy mode:
  // cws-connect resolves the action, injects the token server-side, and calls
  // the provider — the agent needs neither the token nor the provider URL).
  // action format: "toolkit-slug/action-name" (e.g. "github-repos/list").
  // NOTE: proxy-mode only; hidden from the agent surface (help text + reference
  // doc), retained here. conn.invoke routes proxy connections through this same
  // server-side execute endpoint internally.
  'conn.execute': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    if (!resolveSelfMemberId()) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    return post(apiPath(`/connect/connections/${connId}/actions/execute`), {
      action: params.action,
      params: params.params || {},
    });
  },

  // Get connection details (status, owner, scopes, etc.).
  'conn.status': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    return get(apiPath(`/connect/connections/${connId}`));
  },

  // Discover the app-keyed action catalog for an application — the full set of
  // actions the app exposes, each with its input_schema, WITHOUT needing an
  // existing connection. Returns [{toolkit, action, method, description,
  // params, input_schema}]. Unlike conn.actions (connection-scoped and gated
  // on the connection-agent authorization boundary), this is capability
  // metadata readable by any org member — use it to see what an app can do
  // before a connection exists, or to build a per-application capability cache.
  // Resolved strictly by applicationId (the BFF route keys on the path id; it
  // does not accept a slug override, so URL identity always matches the result).
  'conn.app_actions': () => {
    const appId = params.applicationId || params.application_id;
    if (!appId) throw Object.assign(new Error('applicationId is required'), { status: 400 });
    return get(apiPath(`/connect/applications/${appId}/actions`));
  },

  // Cache-aware, app-keyed action catalog. Reads runtime/connect/action-catalog/
  // first and fills it from conn.app_actions on a miss / TTL-expiry / {refresh}.
  // Accepts either {applicationId} directly, or {app} (slug or id) resolved via
  // the local connections index. Returns { applicationId, actions, fetchedAt,
  // source }.
  'conn.catalog': async () => {
    const orgId = resolveOrgId();
    let appId = params.applicationId || params.application_id;
    if (!appId && params.app) {
      const agentId = resolveSelfMemberId(orgId);
      const entry = await resolveConnectionForApp(params.app, orgId, agentId);
      appId = entry?.applicationId || (isUuid(params.app) ? params.app : null);
    }
    if (!appId) throw Object.assign(new Error('applicationId (or a resolvable app) is required'), { status: 400 });
    return getCatalog(orgId, appId, { refresh: !!params.refresh });
  },

  // One-call app-keyed execute: resolve the connection for an application from
  // the local index (refreshing from conn.list on a miss), then run the named
  // action. This is the cache-aware entry meant for agents — it removes the
  // per-call discovery round-trip. Internally it splits on credential_mode
  // (transparent to the caller — same command, same result shape):
  //   - direct → LOCAL EGRESS: assemble the request from the local catalog's
  //     url_template + params, inject the locally-cached token (refreshing it on
  //     near-expiry / a provider 401), and call the provider from THIS host.
  //   - proxy  → server-side execute (cws-connect resolves the action, injects
  //     the token, and calls the provider; connection_agents re-checked there).
  // On an action/schema-shaped failure it invalidates the cached catalog once so
  // the next conn.catalog is fresh, then resurfaces the error.
  'conn.invoke': async () => {
    const app = params.app || params.applicationId || params.application_id || params.slug;
    if (!app) throw Object.assign(new Error('app (slug or applicationId) is required'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    const orgId = resolveOrgId();
    const agentId = resolveSelfMemberId(orgId);
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });

    const entry = await resolveConnectionForApp(app, orgId, agentId);
    if (!entry) throw Object.assign(new Error(`no connection found for app "${app}" (org ${orgId}, agent ${agentId})`), { status: 404 });

    // Decide the path from the local credential cache, re-acquiring on a miss so
    // a direct connection with no cache file (authorized offline / runtime wiped
    // / conn.clear_cache) is not wrongly downgraded to proxy (which cws-connect
    // now rejects with ErrDirectNotProxyable/422). See resolveCredential.
    const { credential, mode } = await resolveCredential(
      { orgId, connectionId: entry.id, cached: readCredentialCache(entry.id) },
      {
        acquire: (oid, connId) => acquireCredential(oid, connId),
        saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
      },
    );

    if (mode === 'direct') {
      if (!entry.applicationId) {
        throw Object.assign(new Error(`cannot run direct action for app "${app}": applicationId unresolved (run conn.index {refresh:true})`), { status: 400 });
      }
      try {
        // The local catalog now carries per-action url_template/headers_template;
        // direct execution assembles the request from it (never a free-form URL).
        const catalogRec = await getCatalog(orgId, entry.applicationId, {});
        return await invokeDirect(
          { orgId, connection: entry, actionSlug: params.action, params: params.params || {}, catalog: catalogRec.actions, credential },
          {
            acquire: (oid, connId) => acquireCredential(oid, connId),
            saveCache: (connId, fresh) => saveCredentialCache(connId, fresh, entry.slug),
          },
        );
      } catch (err) {
        // Drop the cached catalog on an action/schema mismatch OR a 422 (a catalog
        // predating url_template — direct assembly can't proceed) so the agent's
        // next conn.catalog refetches. Re-thrown as-is (no auto-retry).
        if ((looksLikeActionOrSchemaError(err) || err.status === 422) && entry.applicationId) invalidateCatalog(entry.applicationId);
        throw err;
      }
    }

    // proxy mode — server-side execute (existing behavior, unchanged).
    try {
      // Execute against the resolved connection using the SAME org's JWT — a
      // multi-org agent must not run one org's connection with another's token.
      return await postForOrg(orgId, apiPath(`/connect/connections/${entry.id}/actions/execute`), {
        action: params.action,
        params: params.params || {},
      });
    } catch (err) {
      // Stale catalog is a plausible cause of an unknown-action/schema error —
      // drop it so the agent's next conn.catalog refetches. Does not auto-retry
      // (a wrong action name won't fix itself); the error is re-thrown as-is.
      if (looksLikeActionOrSchemaError(err) && entry.applicationId) invalidateCatalog(entry.applicationId);
      throw err;
    }
  },

  // Show the local connections index for an org (observability). {refresh}
  // rebuilds it from conn.list first; {org} selects the org (default otherwise).
  'conn.index': async () => {
    const orgId = resolveOrgId();
    if (params.refresh) {
      const agentId = resolveSelfMemberId(orgId);
      if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
      await refreshIndex(orgId, agentId);
    }
    const index = readIndex(indexPathForOrg(orgId));
    const connections = Object.values(index.connections);
    return { org_id: orgId, count: connections.length, connections };
  },

  // List locally cached credentials (metadata only; shared cache module).
  'conn.cached': () => {
    const entries = listCachedCredentials();
    return { count: entries.length, credentials: entries };
  },

  // Clear cached credentials (all or specific connection).
  'conn.clear_cache': () => {
    const connId = params.connectionId || params.connection_id;
    return { cleared: clearCachedCredentials(connId) };
  },
};

function printUsage() {
  console.log(`Connection CLI — cws-connect operations via cws-core BFF

Usage: node src/cli/conn.js <command> '<json-params>'

Connections
  conn.list           {}                                        # list connections available to this agent (self only)
  conn.acquire        {connectionId}                            # acquire credential (returns access_token or proxy_ref)
  conn.actions        {connectionId}                            # discover named actions for a connection
  conn.status         {connectionId}                            # get connection details (status, owner, scopes)

Applications
  conn.app_actions    {applicationId}                           # app-keyed action catalog (incl. input_schema; no connection needed)

Capability cache (runtime/connect/)
  conn.invoke         {app, action, params?}                    # app-keyed execute: resolve connection via local index → execute
  conn.catalog        {app|applicationId, refresh?}             # cached action catalog (fills from conn.app_actions on miss/TTL)
  conn.index          {refresh?}                                # show the local connections index (connection → application)

Local cache
  conn.cached         {}                                        # list locally cached credentials (direct-mode tokens)
  conn.clear_cache    {connectionId?}                           # clear cached credentials (all if no connectionId)

Environment:
  COCO_API_URL     cws-core base URL (default: http://127.0.0.1:8080)
  COCO_API_PREFIX  Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    const fieldErrors = err.body?.error?.errors;
    if (Array.isArray(fieldErrors) && fieldErrors.length > 0) payload.errors = fieldErrors;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
