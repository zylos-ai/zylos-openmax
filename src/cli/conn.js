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
  // Returns [{toolkit, action, method, description, params}]; pair with
  // conn.execute to invoke one by "toolkit-slug/action-name". Carries the
  // agent's member_id so cws-connect scopes discovery to the same
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

Local cache
  conn.cached         {}                                        # list locally cached credentials
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
