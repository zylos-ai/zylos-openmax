#!/usr/bin/env node

/**
 * Connection CLI — cws-connect operations via cws-core BFF.
 *
 * Usage:
 *   node src/cli/conn.js <command> '<json-params>'
 *   node src/cli/conn.js conn.list     '{}'
 *   node src/cli/conn.js conn.acquire  '{"connectionId":"..."}'
 */

import fs from 'fs';
import path from 'path';
import { get, post, del, patch, apiPath } from '../lib/client.js';
import { loadConfig, enabledOrgs, resolveDefaultOrgId } from '../lib/config.js';
import { RUNTIME_DIR } from '../lib/session.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

const CREDENTIALS_DIR = path.join(RUNTIME_DIR, 'credentials');

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

  // Get connection details (status, owner, scopes, etc.).
  'conn.status': () => {
    const connId = params.connectionId || params.connection_id;
    if (!connId) throw Object.assign(new Error('connectionId is required'), { status: 400 });
    return get(apiPath(`/connect/connections/${connId}`));
  },

  // List locally cached credentials.
  'conn.cached': () => {
    try {
      const files = fs.readdirSync(CREDENTIALS_DIR).filter(f => f.endsWith('.json'));
      const entries = files.map(f => {
        const connId = f.replace('.json', '');
        try {
          const data = JSON.parse(fs.readFileSync(path.join(CREDENTIALS_DIR, f), 'utf8'));
          return {
            connection_id: connId,
            credential_mode: data.credential_mode || '?',
            has_access_token: !!data.access_token,
            has_proxy_ref: !!data.proxy_ref,
          };
        } catch {
          return { connection_id: connId, error: 'parse_failed' };
        }
      });
      return { count: entries.length, credentials: entries };
    } catch {
      return { count: 0, credentials: [] };
    }
  },

  // Clear cached credentials (all or specific connection).
  'conn.clear_cache': () => {
    const connId = params.connectionId || params.connection_id;
    if (connId) {
      const fp = path.join(CREDENTIALS_DIR, `${connId}.json`);
      try { fs.unlinkSync(fp); } catch {}
      return { cleared: [connId] };
    }
    try {
      const files = fs.readdirSync(CREDENTIALS_DIR).filter(f => f.endsWith('.json'));
      for (const f of files) fs.unlinkSync(path.join(CREDENTIALS_DIR, f));
      return { cleared: files.map(f => f.replace('.json', '')) };
    } catch {
      return { cleared: [] };
    }
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
