#!/usr/bin/env node

/**
 * Post-install hook for zylos-coco-workspace.
 *
 * Called by `zylos install` after `npm install`. Mode:
 *   - Terminal (stdio inherited, TTY): runs interactive prompts.
 *   - JSON (piped, no TTY): runs silently, prints instructions.
 *
 * What it does:
 *   1. Create data subdirectories under ~/zylos/components/coco-workspace/
 *   2. Initialize config.json from DEFAULT_CONFIG if missing
 *   3. Generate device_id and client_id (UUIDv4) if not set
 *   4. Prompt for workspace_id  → config.json (cws-core scope)
 *   5. Prompt for org_id        → config.json (cws-kb / cws-as scope)
 *   6. Prompt for api_key       → ~/zylos/.env  (COCO_AUTH_TOKEN)
 *
 * The split between config.json (non-secret) and ~/zylos/.env (secret)
 * mirrors the zylos-lark convention: workspace_id is just an ID and
 * lives in the per-component config; the API key is a credential and
 * stays in the shared .env so it's not committed by accident.
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

/**
 * In-place update of a single env var in ~/zylos/.env. Preserves all other
 * entries. Creates the file with mode 0600 if it does not exist.
 */
function updateEnvVar(name, value) {
  let content = '';
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch {}
  const lines = content.split('\n');
  const re = new RegExp(`^\\s*${name}\\s*=`);
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      lines[i] = `${name}=${value}`;
      found = true;
      break;
    }
  }
  if (!found) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    lines.push(`${name}=${value}`);
  }
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  lines.push('');
  fs.writeFileSync(ENV_PATH, lines.join('\n'), { mode: 0o600 });
}

/**
 * Read a single env var from ~/zylos/.env without sourcing it. Returns ''
 * if file/key missing. process.env is also checked as a fallback.
 */
function readEnvVar(name) {
  if (process.env[name]) return process.env[name];
  let content;
  try { content = fs.readFileSync(ENV_PATH, 'utf8'); } catch { return ''; }
  const re = new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm');
  const m = content.match(re);
  return m ? m[1].replace(/^["']|["']$/g, '') : '';
}

console.log('[post-install] zylos-coco-workspace');

// 1. Create data subdirectories
for (const d of ['logs', 'media', 'runtime']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}
console.log('  data dirs ready under', DATA_DIR);

// 2. Load existing config (or seed from defaults)
let config;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    console.warn(`  WARN: existing config.json is invalid (${err.message}); re-seeding from defaults`);
    config = { ...DEFAULT_CONFIG };
  }
} else {
  config = { ...DEFAULT_CONFIG };
}

// 3. Auto-generate device_id / client_id if missing (UUIDv4, persisted across restarts)
if (!config.device_id) {
  config.device_id = crypto.randomUUID();
  console.log('  generated device_id', config.device_id);
}
if (!config.client_id) {
  config.client_id = crypto.randomUUID();
  console.log('  generated client_id', config.client_id);
}

// ── Helper: register agent against cws-core ────────────────────────────────
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

// 4. Interactive setup (only in TTY mode)
if (isInteractive) {
  console.log('');
  console.log('========================================');
  console.log('  COCO Workspace — initial setup');
  console.log('========================================');

  // ── cws-core URL (needed for registration) ──────────────────────────────
  const defaultCoreUrl = config.comm?.core_url || 'http://127.0.0.1:8080';
  const coreUrlInput = await ask(`  cws-core URL [${defaultCoreUrl}]: `);
  const coreUrl = (coreUrlInput || defaultCoreUrl).replace(/\/$/, '');
  if (coreUrl !== defaultCoreUrl) {
    if (!config.comm) config.comm = {};
    config.comm.core_url = coreUrl;
    console.log('  ✓ core_url saved to config.json');
  }

  // ── Agent registration ──────────────────────────────────────────────────
  const existingKey = readEnvVar('COCO_AUTH_TOKEN');
  if (existingKey) {
    console.log('');
    console.log('  COCO_AUTH_TOKEN already present — skipping registration.');
    if (!config.agent) config.agent = {};
  } else {
    console.log('');
    console.log('  Step 1: Register this agent with cws-core');
    console.log('  (POST /auth/register/agent — no auth required)');
    console.log('');

    const defaultUsername = `zylos-agent-${crypto.randomUUID().slice(0, 8)}`;
    const username = (await ask(`  Agent username [${defaultUsername}]: `)) || defaultUsername;
    const displayName = (await ask('  Agent display name [Zylos Agent]: ')) || 'Zylos Agent';

    console.log(`  Registering as "${username}" at ${coreUrl}...`);
    try {
      const { identity_id, api_key } = await registerAgent(coreUrl, username, displayName);
      updateEnvVar('COCO_AUTH_TOKEN', api_key);
      if (!config.agent) config.agent = {};
      config.agent.identity_id = identity_id;
      console.log('  ✓ api_key saved to ~/zylos/.env as COCO_AUTH_TOKEN');
      console.log('  ✓ identity_id saved to config.json:', identity_id);
    } catch (err) {
      console.error('  ✗ Registration failed:', err.message);
      console.log('  You can retry later by running this hook again, or set COCO_AUTH_TOKEN manually.');
    }
  }

  // ── Workspace ID ────────────────────────────────────────────────────────
  console.log('');
  console.log('  Step 2: Workspace and organisation IDs');
  console.log('  (find these in the workspace admin console / org owner invitation)');
  console.log('');

  if (!config.workspace_id) {
    const wsId = await ask('  Workspace ID (cws-core scope, e.g. ws_abc123): ');
    if (wsId) {
      config.workspace_id = wsId;
      console.log('  ✓ workspace_id saved to config.json');
    } else {
      console.log('  ! workspace_id left empty — service will warn on startup');
    }
  } else {
    console.log(`  workspace_id already set (${config.workspace_id})`);
  }

  if (!config.org_id) {
    const orgId = await ask('  Org ID (from org owner invitation, cws-kb / cws-as scope): ');
    if (orgId) {
      config.org_id = orgId;
      console.log('  ✓ org_id saved to config.json');
    } else {
      console.log('  ! org_id left empty — token exchange and WS connection will fail until set');
    }
  } else {
    console.log(`  org_id already set (${config.org_id})`);
  }
} else {
  console.log('');
  console.log('[post-install] non-interactive mode — skipping prompts');
  console.log('[post-install] before starting the service, complete these steps:');
  console.log('  1. Register the agent:');
  console.log('       POST <core_url>/auth/register/agent');
  console.log('       Body: { username, display_name }');
  console.log('       → save api_key to COCO_AUTH_TOKEN in ~/zylos/.env');
  console.log('       → save identity_id to config.json agent.identity_id');
  console.log('  2. Set in config.json:');
  console.log(`       workspace_id, org_id, comm.core_url`);
  console.log(`     Config path: ${CONFIG_PATH}`);
}

// 5. Persist config back
fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('  config.json written');

console.log('\n[post-install] complete');
if (isInteractive) {
  console.log('\nNext steps:');
  console.log('  - Start the service:  pm2 start ecosystem.config.cjs');
  console.log('  - Check connectivity: pm2 logs zylos-coco-workspace --lines 50');
}
