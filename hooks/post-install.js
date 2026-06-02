#!/usr/bin/env node

/**
 * Post-install hook for zylos-coco-workspace.
 *
 * Two modes, picked by whether stdin is a TTY:
 *
 *   1. Interactive (TTY): prompt operator for BFF URL, agent name, org info;
 *      register the agent against cws-core; write everything to config.json.
 *
 *   2. Non-interactive (no TTY): env-driven bootstrap. Reads a fixed set of
 *      env vars; if the required ones are present and config.json doesn't
 *      already have an api_key, calls POST /auth/register/agent and writes
 *      the resulting api_key + identity_id + org block into config.json.
 *
 *      Required env vars (non-interactive bootstrap):
 *        - COCO_BFF_URL              cws-core REST base URL
 *        - COCO_WS_URL               cws-comm WebSocket URL
 *        - COCO_AGENT_TICKET         one-time registration ticket
 *        - COCO_AGENT_NAME           agent display name
 *        - COCO_ORG_ID               COCO org UUID this agent serves
 *        - COCO_SELF_MEMBER_ID       agent's member id within that org
 *      Optional:
 *        - COCO_ORG_NAME             display name (default 'default')
 *        - COCO_ORG_SLUG             config-key slug (default derived from ORG_NAME)
 *        - COCO_DM_POLICY            default 'owner'
 *        - COCO_GROUP_POLICY         default 'allowlist'
 *
 * api_key lives **in config.json** (`agent.api_key`). There is no .env
 * dependency. The runtime reads api_key from config.json first; env-var
 * COCO_AUTH_TOKEN remains supported only as a back-compat override.
 *
 * Idempotency: if config.agent.api_key is already set, the bootstrap skips
 * the registration call entirely. Re-running prepare in any mode is safe.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

const HOME = process.env.HOME;
const DATA_DIR    = path.join(HOME, 'zylos/components/coco-workspace');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const ENV_PATH    = path.join(HOME, 'zylos/.env');

const isInteractive = process.stdin.isTTY === true;

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function updateEnvVar(name, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  const lines = content.split('\n');
  const re = new RegExp(`^\\s*${name}\\s*=`);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) { lines[i] = `${name}=${value}`; found = true; break; }
  }
  if (!found) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${name}=${value}`);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('');
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
}

function readEnvVar(name) {
  if (process.env[name]) return process.env[name];
  let content;
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return ''; }
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm');
  const m = content.match(re);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

console.log('[post-install] zylos-coco-workspace');

for (const d of ['logs', 'media', 'runtime', 'runtime/tokens']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}
console.log('  data dirs ready under', DATA_DIR);

// Load existing config (or seed from defaults)
let config;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    console.warn(`  WARN: existing config.json is invalid (${err.message}); re-seeding from defaults`);
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
} else {
  config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

if (!config.agent) config.agent = {};
if (!config.agent.device_id) {
  config.agent.device_id = crypto.randomUUID();
  console.log('  generated agent.device_id', config.agent.device_id);
}
if (!config.agent.client_id) {
  config.agent.client_id = crypto.randomUUID();
  console.log('  generated agent.client_id', config.agent.client_id);
}
if (!config.orgs) config.orgs = {};

async function registerAgent(coreUrl, username, displayName, ticket) {
  const body = { username, display_name: displayName };
  if (ticket) body.ticket = ticket;
  const res = await fetch(`${coreUrl.replace(/\/$/, '')}/auth/register/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text;
    throw new Error(`registration failed (${res.status}): ${msg}`);
  }
  return data; // { identity_id, api_key }
}

function deriveSlug(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

if (isInteractive) {
  console.log('');
  console.log('========================================');
  console.log('  COCO Workspace — initial setup');
  console.log('========================================');

  const defaultBff = config.server?.bff_url || 'http://127.0.0.1:8080';
  const bffInput = await ask(`  cws-core URL [${defaultBff}]: `);
  const bffUrl = (bffInput || defaultBff).replace(/\/$/, '');
  if (!config.server) config.server = {};
  config.server.bff_url = bffUrl;
  if (!config.server.ws_url) config.server.ws_url = bffUrl.replace(/^http/, 'ws') + '/ws';

  const existingKey = config.agent?.api_key || readEnvVar('COCO_AUTH_TOKEN');
  if (existingKey) {
    console.log('');
    console.log('  agent.api_key already present — skipping registration.');
  } else {
    console.log('');
    console.log('  Step 1: Register this agent with cws-core');
    console.log('  (POST /auth/register/agent — no auth required)');
    const defaultUsername = `zylos-agent-${crypto.randomUUID().slice(0, 8)}`;
    const username = (await ask(`  Agent username [${defaultUsername}]: `)) || defaultUsername;
    const displayName = (await ask('  Agent display name [Zylos Agent]: ')) || 'Zylos Agent';

    console.log(`  Registering as "${username}" at ${bffUrl}...`);
    try {
      const { identity_id, api_key } = await registerAgent(bffUrl, username, displayName);
      config.agent.identity_id = identity_id;
      config.agent.api_key = api_key;
      console.log('  ✓ api_key + identity_id saved to config.json');
    } catch (err) {
      console.error('  ✗ Registration failed:', err.message);
      console.log('  You can retry later or set config.agent.api_key manually.');
    }
  }

  console.log('');
  console.log('  Step 2: Add your first org (you can add more later by editing config.json)');
  console.log('');

  const hasOrg = Object.values(config.orgs).some(o => o?.org_id);
  if (!hasOrg) {
    const orgId = await ask('  Org ID (COCO org UUID, from org owner invitation): ');
    if (orgId) {
      const orgName = (await ask('  Org name (display only) [default]: ')) || 'default';
      const memberId = await ask('  Member ID (this agent\'s member id within the org; leave blank to fill later): ');
      const displayName = (await ask('  Agent display name in this org [Zylos]: ')) || 'Zylos';

      const slug = orgName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-|-$/g, '') || 'default';
      config.orgs[slug] = {
        enabled: true,
        org_id: orgId,
        org_name: orgName,
        self:  { member_id: memberId || '', name: displayName },
        owner: { member_id: '', name: '' },
        access: {
          dmPolicy:    'owner',
          dmAllowFrom: [],
          groupPolicy: 'allowlist',
          groups:      {},
        },
      };
      console.log(`  ✓ org "${slug}" added to config.json`);
      if (!memberId) {
        console.log(`  ! self.member_id left blank — service will reject self-echo correctly only after you fill this in`);
      }
    } else {
      console.log('  ! org_id left empty — no WebSocket will start until you add an org block');
    }
  } else {
    const slugs = Object.keys(config.orgs).filter(s => config.orgs[s]?.org_id);
    console.log(`  ${slugs.length} org(s) already configured: ${slugs.join(', ')}`);
  }

  console.log('');
  console.log('  Step 3 (optional): Configure access policy');
  console.log('    Each org has an `access` block in config.json:');
  console.log('      dmPolicy:    "open" | "allowlist" | "owner"');
  console.log('      dmAllowFrom: []                            (used when dmPolicy=allowlist)');
  console.log('      groupPolicy: "open" | "allowlist" | "disabled"');
  console.log('      groups:      { "<conv-uuid>": { name, mode, allowFrom } }');
  console.log('    Defaults are dmPolicy=owner (first DMer auto-binds) + groupPolicy=allowlist.');
} else {
  // Non-interactive bootstrap. Reads env vars (typically set by the K8s
  // prepare-job via the prepare-plan command's `env` field).
  const envBff       = process.env.COCO_BFF_URL || '';
  const envWs        = process.env.COCO_WS_URL  || '';
  const envTicket    = process.env.COCO_AGENT_TICKET || '';
  const envAgent     = process.env.COCO_AGENT_NAME   || '';
  const envOrgId     = process.env.COCO_ORG_ID || '';
  const envSelfId    = process.env.COCO_SELF_MEMBER_ID || '';
  const envOrgName   = process.env.COCO_ORG_NAME || 'default';
  const envOrgSlug   = process.env.COCO_ORG_SLUG || deriveSlug(envOrgName);
  const envDmPolicy  = process.env.COCO_DM_POLICY    || 'owner';
  const envGroupPol  = process.env.COCO_GROUP_POLICY || 'allowlist';

  const hasRequired = envBff && envTicket && envAgent && envOrgId && envSelfId;
  const alreadyRegistered = !!config.agent?.api_key;

  if (alreadyRegistered) {
    console.log('[post-install] agent.api_key already in config.json — skipping registration (idempotent)');
  } else if (!hasRequired) {
    console.log('[post-install] non-interactive mode: required env vars missing — skipping bootstrap');
    console.log('  required: COCO_BFF_URL, COCO_AGENT_TICKET, COCO_AGENT_NAME, COCO_ORG_ID, COCO_SELF_MEMBER_ID');
    console.log('  the service will fail to start until config.agent.api_key and at least one orgs.<slug> are set');
  } else {
    if (!config.server) config.server = {};
    config.server.bff_url = envBff.replace(/\/$/, '');
    config.server.ws_url  = envWs || config.server.bff_url.replace(/^http/, 'ws') + '/ws';

    console.log(`[post-install] registering agent "${envAgent}" at ${config.server.bff_url}`);
    try {
      const { identity_id, api_key } = await registerAgent(
        config.server.bff_url, envAgent, envAgent, envTicket,
      );
      config.agent.identity_id = identity_id;
      config.agent.api_key     = api_key;
      console.log('[post-install] registration ok — api_key + identity_id written to config.json');
    } catch (err) {
      console.error('[post-install] registration failed:', err.message);
      process.exit(1);
    }

    // Seed the single org block from env. Operator can edit / add more later.
    if (!config.orgs[envOrgSlug]) {
      config.orgs[envOrgSlug] = {
        enabled: true,
        org_id:   envOrgId,
        org_name: envOrgName,
        self:  { member_id: envSelfId, name: envAgent },
        owner: { member_id: '', name: '' },
        access: {
          dmPolicy:    envDmPolicy,
          dmAllowFrom: [],
          groupPolicy: envGroupPol,
          groups:      {},
        },
      };
      console.log(`[post-install] org "${envOrgSlug}" seeded (org_id=${envOrgId}, self.member_id=${envSelfId})`);
    } else {
      console.log(`[post-install] org "${envOrgSlug}" already in config — leaving as-is`);
    }
  }
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('  config.json written');

console.log('\n[post-install] complete');
if (isInteractive) {
  console.log('\nNext steps:');
  console.log('  - Start the service:  pm2 start ecosystem.config.cjs');
  console.log('  - Check connectivity: pm2 logs zylos-coco-workspace --lines 50');
}
