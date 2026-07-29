#!/usr/bin/env node

/**
 * Connection CLI — cws-connect operations via cws-core BFF.
 *
 * Usage:
 *   node src/cli/conn.js <command> '<json-params>'
 *   node src/cli/conn.js conn.list     '{}'
 *   node src/cli/conn.js conn.acquire  '{"connectionId":"..."}'
 */

import { get, post, del, patch, apiPath } from '../lib/client.js';
import { loadConfig, enabledOrgs, resolveDefaultOrgId } from '../lib/config.js';
import { listCachedCredentials, clearCachedCredentials } from '../lib/credential-cache.js';
import {
  readIndex, replaceIndexFromList, findConnectionByApp,
  readCatalog, writeCatalog, invalidateCatalog, CATALOG_TTL_MS,
} from '../lib/connect-store.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

function resolveSelfMemberId() {
  const cfg = loadConfig();
  const orgId = resolveDefaultOrgId();
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

// Fetch this agent's connections from cws-core and rewrite the local index.
async function refreshIndex(agentId) {
  const list = await get(apiPath(`/connect/agents/${agentId}/connections`));
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []));
  return readIndex();
}

// Resolve an application (slug or applicationId) → its connection entry, reading
// the local index first and refreshing from conn.list once on a miss.
async function resolveConnectionForApp(app, agentId) {
  let entry = findConnectionByApp(app);
  if (!entry) {
    await refreshIndex(agentId);
    entry = findConnectionByApp(app);
  }
  return entry;
}

// Return an application's action catalog, reading the cache first and filling it
// via conn.app_actions on a miss / TTL-expiry / explicit refresh.
async function getCatalog(applicationId, { refresh = false, ttlMs = CATALOG_TTL_MS } = {}) {
  if (!refresh) {
    const cached = readCatalog(applicationId, { ttlMs });
    if (cached) return { ...cached, source: 'cache' };
  }
  const actions = actionsOf(await get(apiPath(`/connect/applications/${applicationId}/actions`)));
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
  // Uses the agent's own member_id by default.
  'conn.list': () => {
    const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return get(apiPath(`/connect/agents/${agentId}/connections`));
  },

  // Acquire credential for a connection.
  // Returns credential_mode + access_token (direct) or proxy_ref (proxy).
  'conn.acquire': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return post(apiPath(`/connect/connections/${connId}/credential?agent_member_id=${encodeURIComponent(agentId)}`));
  },

  // Proxy a request through a connection (proxy mode).
  'conn.proxy': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
    return post(apiPath(`/connect/connections/${connId}/proxy`), {
      agent_member_id: agentId,
      method: params.method || 'GET',
      url: params.url,
      headers: params.headers,
      body: params.body,
    });
  },

  // Discover the named actions available for a connection (action discovery).
  // Returns [{toolkit, action, method, description, params, input_schema}];
  // pair with conn.execute to invoke one by "toolkit-slug/action-name". Carries
  // the agent's member_id so cws-connect scopes discovery to the same
  // connection-agent authorization boundary as conn.execute/conn.proxy.
  'conn.actions': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    return get(apiPath(`/connect/connections/${connId}/actions?agent_member_id=${encodeURIComponent(agentId)}`));
  },

  // Execute a registered named action through a connection (proxy mode:
  // cws-connect resolves the action, injects the token server-side, and calls
  // the provider — the agent needs neither the token nor the provider URL).
  // action format: "toolkit-slug/action-name" (e.g. "github-repos/list").
  'conn.execute': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    return post(apiPath(`/connect/connections/${connId}/actions/execute`), {
      agent_member_id: agentId,
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
    let appId = params.applicationId || params.application_id;
    if (!appId && params.app) {
      const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
      const entry = await resolveConnectionForApp(params.app, agentId);
      appId = entry?.applicationId || (isUuid(params.app) ? params.app : null);
    }
    if (!appId) throw Object.assign(new Error('applicationId (or a resolvable app) is required'), { status: 400 });
    return getCatalog(appId, { refresh: !!params.refresh });
  },

  // One-call app-keyed execute: resolve the connection for an application from
  // the local index (refreshing from conn.list on a miss), then run the named
  // action via conn.execute. This is the cache-aware entry meant for agents —
  // it removes the per-call discovery round-trip while keeping authorization +
  // token injection fully server-side (conn.execute re-checks connection_agents).
  // On an action/schema-shaped failure it invalidates the cached catalog once so
  // the next conn.catalog is fresh, then resurfaces the error.
  'conn.invoke': async () => {
    const app = params.app || params.applicationId || params.application_id || params.slug;
    if (!app) throw Object.assign(new Error('app (slug or applicationId) is required'), { status: 400 });
    if (!params.action) throw Object.assign(new Error('action is required (format: toolkit-slug/action-name)'), { status: 400 });
    const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
    if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });

    const entry = await resolveConnectionForApp(app, agentId);
    if (!entry) throw Object.assign(new Error(`no connection found for app "${app}" (agent ${agentId})`), { status: 404 });

    try {
      return await post(apiPath(`/connect/connections/${entry.id}/actions/execute`), {
        agent_member_id: agentId,
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

  // Show the local connections index (observability). {refresh} rebuilds it from
  // conn.list first.
  'conn.index': async () => {
    if (params.refresh) {
      const agentId = params.agentMemberId || params.agent_member_id || resolveSelfMemberId();
      if (!agentId) throw Object.assign(new Error('cannot resolve agent member_id'), { status: 400 });
      await refreshIndex(agentId);
    }
    const index = readIndex();
    const connections = Object.values(index.connections);
    return { count: connections.length, connections };
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
  conn.list           {agentMemberId?}                          # list connections available to this agent (default: self)
  conn.acquire        {connectionId, agentMemberId?}            # acquire credential (returns access_token or proxy_ref)
  conn.proxy          {connectionId, method, url,               # proxy a request through a connection
                       headers?, body?, agentMemberId?}
  conn.actions        {connectionId, agentMemberId?}            # discover named actions for a connection
  conn.execute        {connectionId, action, params?,           # run a named action (toolkit-slug/action-name)
                       agentMemberId?}                          #   via cws-connect (server injects the token)
  conn.status         {connectionId}                            # get connection details (status, owner, scopes)

Applications
  conn.app_actions    {applicationId}                           # app-keyed action catalog (incl. input_schema; no connection needed)

Capability cache (runtime/connect/)
  conn.invoke         {app, action, params?, agentMemberId?}    # app-keyed execute: resolve connection via local index → execute
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
