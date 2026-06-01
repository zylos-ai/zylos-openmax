#!/usr/bin/env node

/**
 * Post-install hook for zylos-coco-workspace.
 *
 * Multi-org architecture (v0.4):
 *   - One agent identity (api_key + identity_id) can be a member of N orgs.
 *   - Each enabled org gets its own WebSocket connection + its own policy.
 *
 * What this hook does:
 *   1. Create data subdirectories under ~/zylos/components/coco-workspace/
 *   2. Initialize config.json from DEFAULT_CONFIG if missing
 *   3. Generate agent.device_id / agent.client_id (UUIDv4) if not set
 *   4. (TTY only) Register the agent against cws-core, write api_key to .env
 *   5. (TTY only) Prompt for ONE initial org (org_id + member_id) and write
 *      it as `orgs.default`. Operator can add more orgs later by editing
 *      config.json.
 *
 * The split between config.json (non-secret) and ~/zylos/.env (secret) is
 * preserved: api_key lives only in .env as COCO_AUTH_TOKEN.
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

async function registerAgent(coreUrl, username, displayName) {
  const res = await fetch(`${coreUrl}/auth/register/agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, display_name: displayName }),
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

  const existingKey = readEnvVar('COCO_AUTH_TOKEN');
  if (existingKey) {
    console.log('');
    console.log('  COCO_AUTH_TOKEN already present — skipping registration.');
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
      updateEnvVar('COCO_AUTH_TOKEN', api_key);
      config.agent.identity_id = identity_id;
      console.log('  ✓ api_key saved to ~/zylos/.env as COCO_AUTH_TOKEN');
      console.log('  ✓ identity_id saved to config.json:', identity_id);
    } catch (err) {
      console.error('  ✗ Registration failed:', err.message);
      console.log('  You can retry later or set COCO_AUTH_TOKEN manually.');
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
        member_id: memberId || '',
        display_name: displayName,
        owner: { bound: false, member_id: '', name: '' },
        access: {
          dmPolicy:    'owner',
          dmAllowFrom: [],
          groupPolicy: 'allowlist',
          groups:      {},
        },
      };
      console.log(`  ✓ org "${slug}" added to config.json`);
      if (!memberId) {
        console.log(`  ! member_id left blank — service will reject self-echo correctly only after you fill this in`);
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
  console.log('');
  console.log('[post-install] non-interactive mode — skipping prompts');
  console.log('[post-install] before starting the service:');
  console.log('  1. Register the agent:');
  console.log('       POST <server.bff_url>/auth/register/agent  { username, display_name }');
  console.log('       → save api_key to COCO_AUTH_TOKEN in ~/zylos/.env');
  console.log('       → save identity_id to config.json agent.identity_id');
  console.log('  2. Add at least one org block under `orgs.<slug>` in config.json:');
  console.log('       { enabled, org_id, member_id, display_name, owner, access }');
  console.log('     See defaults / template comments in src/lib/config.js DEFAULT_CONFIG.');
  console.log(`     Config path: ${CONFIG_PATH}`);
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('  config.json written');

console.log('\n[post-install] complete');
if (isInteractive) {
  console.log('\nNext steps:');
  console.log('  - Start the service:  pm2 start ecosystem.config.cjs');
  console.log('  - Check connectivity: pm2 logs zylos-coco-workspace --lines 50');
}
