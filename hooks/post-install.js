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
 *   4. Prompt for workspace_id  → ~/zylos/components/coco-workspace/config.json
 *   5. Prompt for api_key       → ~/zylos/.env  (COCO_AUTH_TOKEN)
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

// 4. Interactive setup (only in TTY mode)
if (isInteractive) {
  console.log('');
  console.log('========================================');
  console.log('  COCO Workspace — initial setup');
  console.log('========================================');
  console.log('');
  console.log('Two values are required to connect this agent to your workspace.');
  console.log('Both come from the workspace admin console.');
  console.log('Press Enter to skip a field; you can fill it in later.');
  console.log('');

  if (!config.workspace_id) {
    const wsId = await ask('  Workspace ID (e.g. ws_abc123): ');
    if (wsId) {
      config.workspace_id = wsId;
      console.log('  ✓ workspace_id saved to config.json');
    } else {
      console.log('  ! workspace_id left empty — service will warn on startup');
    }
  } else {
    console.log(`  workspace_id already set (${config.workspace_id})`);
  }

  const existingKey = readEnvVar('COCO_AUTH_TOKEN');
  if (!existingKey) {
    const apiKey = await ask('  Agent API Key (e.g. apikey_xxxxxx): ');
    if (apiKey) {
      updateEnvVar('COCO_AUTH_TOKEN', apiKey);
      console.log('  ✓ api_key saved to ~/zylos/.env as COCO_AUTH_TOKEN');
    } else {
      console.log('  ! api_key left empty — service will fail at WS upgrade until COCO_AUTH_TOKEN is set');
    }
  } else {
    console.log('  COCO_AUTH_TOKEN already present in ~/zylos/.env (not overwritten)');
  }
} else {
  console.log('');
  console.log('[post-install] non-interactive mode — skipping prompts');
  console.log('[post-install] before starting the service, set:');
  console.log(`  - workspace_id    in ${CONFIG_PATH}`);
  console.log('  - COCO_AUTH_TOKEN in ~/zylos/.env');
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
