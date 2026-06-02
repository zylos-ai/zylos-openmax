#!/usr/bin/env node

/**
 * Post-install hook for zylos-coco-workspace.
 *
 * Two modes, picked by whether stdin is a TTY:
 *
 *   1. Interactive (TTY): prompt operator for the bare minimum — bff_url,
 *      ws_url, then auto-call POST /auth/register/agent (body: {}) to mint
 *      identity_id + api_key and write them into config.json. Finally, a
 *      multi-org loop accepts zero or more org_ids (one per line, blank to
 *      finish). No member_id, no display_name, no access policy is asked —
 *      member_id is auto-filled on first JWT exchange from the JWT claims,
 *      and access policy defaults to dmPolicy=owner / groupPolicy=allowlist.
 *
 *   2. Non-interactive (no TTY): env-driven bootstrap. Reads a small env
 *      surface and performs the same register + (optional) org seeding.
 *
 *      Required env vars (non-interactive bootstrap):
 *        - COCO_BFF_URL              cws-core REST base URL
 *      Optional:
 *        - COCO_WS_URL               cws-comm WebSocket URL (derived from BFF if omitted)
 *        - COCO_ORG_IDS              comma-separated list of org UUIDs to seed
 *
 * Registration failure (any mode) is a HARD FAILURE — the hook exits with
 * code 1 and does NOT write config.json. The operator must re-run after
 * fixing connectivity or auth.
 *
 * api_key lives **in config.json** (`agent.api_key`). There is no .env
 * file involved anywhere in this codebase — neither read nor written.
 *
 * Idempotency: if config.agent.api_key is already set, the registration
 * call is skipped. Re-running prepare in any mode is safe.
 *
 * 🚧 TEMP: every fetch carries Cloudflare Access service-token headers via
 * cf-access.js. Delete that import + spread before the first production
 * release.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import readline from 'readline';
import { DEFAULT_CONFIG } from '../src/lib/config.js';
import { cfAccessHeaders } from '../src/lib/cf-access.js';

const HOME = process.env.HOME;
const DATA_DIR    = path.join(HOME, 'zylos/components/coco-workspace');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

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

console.log('[install] zylos-coco-workspace');

for (const d of ['logs', 'media', 'runtime', 'runtime/tokens']) {
  fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
}
console.log('[install] data dirs ready under', DATA_DIR);

// Load existing config (or seed from defaults)
let config;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    console.warn(`[install] existing config.json is invalid (${err.message}); re-seeding from defaults`);
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
} else {
  config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

if (!config.agent) config.agent = {};
if (!config.agent.device_id) {
  config.agent.device_id = crypto.randomUUID();
  console.log('[install] generated agent.device_id', config.agent.device_id);
}
if (!config.orgs) config.orgs = {};

async function registerAgent(coreUrl) {
  const url = `${coreUrl.replace(/\/$/, '')}/auth/register/agent`;
  console.log(`[install] POST ${url}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...cfAccessHeaders(),
    },
    body: JSON.stringify({}),     // empty body — cws-core requires no fields
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text;
    throw new Error(`registration failed (${res.status}): ${msg}`);
  }
  // D8 envelope: { data: { identity_id, api_key }, request_id, server_time }
  const d = (data && typeof data === 'object' && data.data) ? data.data : data;
  if (!d?.identity_id || !d?.api_key) {
    throw new Error('registration returned no identity_id/api_key');
  }
  return d;
}

function seedOrg(orgId) {
  if (!orgId) return;
  // Skip if any existing org block already holds this org_id.
  for (const existing of Object.values(config.orgs)) {
    if (existing?.org_id === orgId) {
      console.log(`[install] org ${orgId} already in config — skipping`);
      return;
    }
  }
  // Generate a stable slug — we use a short prefix of the org_id so the key
  // is deterministic but human-distinguishable from other entries.
  const slug = `org-${orgId.slice(0, 8)}`;
  config.orgs[slug] = {
    enabled: true,
    org_id: orgId,
    org_name: '',
    self:  { member_id: '', name: 'Zylos' },     // member_id auto-filled at runtime
    owner: { member_id: '', name: '' },
    access: {
      dmPolicy:    'owner',
      dmAllowFrom: [],
      groupPolicy: 'allowlist',
      groups:      {},
    },
  };
  console.log(`[install] org "${slug}" seeded (org_id=${orgId})`);
}

function deriveWsUrl(bffUrl) {
  return bffUrl.replace(/^http/, 'ws') + '/ws';
}

if (isInteractive) {
  console.log('');
  console.log('========================================');
  console.log('  COCO Workspace — initial setup');
  console.log('========================================');

  // Step 1: endpoints
  const defaultBff = config.server?.bff_url || 'http://127.0.0.1:8080';
  const bffInput = await ask(`  cws-core REST URL (bff_url) [${defaultBff}]: `);
  const bffUrl = (bffInput || defaultBff).replace(/\/$/, '');

  const defaultWs = config.server?.ws_url || deriveWsUrl(bffUrl);
  const wsInput = await ask(`  cws-comm WebSocket URL (ws_url) [${defaultWs}]: `);
  const wsUrl = wsInput || defaultWs;

  if (!config.server) config.server = {};
  config.server.bff_url = bffUrl;
  config.server.ws_url  = wsUrl;
  console.log(`[install] endpoints set: bff_url=${bffUrl}  ws_url=${wsUrl}`);

  // Step 2: register agent (skip if already present)
  if (config.agent.api_key) {
    console.log('[install] agent.api_key already in config — skipping registration');
  } else {
    console.log('[install] registering agent against cws-core (POST /auth/register/agent)');
    let reg;
    try {
      reg = await registerAgent(bffUrl);
    } catch (err) {
      console.error('[install] ✗ registration failed:', err.message);
      console.error('[install] aborting — config.json NOT written. Fix bff_url / network and re-run.');
      process.exit(1);
    }
    config.agent.identity_id = reg.identity_id;
    config.agent.api_key     = reg.api_key;
    console.log(`[install] ✓ registered: identity_id=${reg.identity_id}`);
    console.log('[install] api_key written to config.json (shown only once by server)');
  }

  // Step 3: multi-org loop
  console.log('');
  console.log('  Org IDs (paste UUID, blank line to finish):');
  let added = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const orgId = await ask(`    org_id [${added === 0 ? 'optional — blank to skip' : 'blank to finish'}]: `);
    if (!orgId) break;
    seedOrg(orgId);
    added += 1;
  }
  if (added === 0) {
    console.log('[install] no orgs configured — service will start but stay idle until you add an org block to config.json and restart');
  } else {
    console.log(`[install] ${added} org(s) configured`);
    console.log('[install] member_id and access policy will auto-fill at runtime');
    console.log('[install] (edit config.json to refine dmPolicy / groupPolicy later)');
  }
} else {
  // Non-interactive bootstrap.
  const envBff = (process.env.COCO_BFF_URL || '').replace(/\/$/, '');
  const envWs  = process.env.COCO_WS_URL || '';
  const envOrgIds = (process.env.COCO_ORG_IDS || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!envBff) {
    console.error('[install] non-interactive mode: COCO_BFF_URL is required');
    process.exit(1);
  }

  if (!config.server) config.server = {};
  config.server.bff_url = envBff;
  config.server.ws_url  = envWs || deriveWsUrl(envBff);
  console.log(`[install] endpoints set: bff_url=${config.server.bff_url}  ws_url=${config.server.ws_url}`);

  if (config.agent.api_key) {
    console.log('[install] agent.api_key already in config — skipping registration (idempotent)');
  } else {
    console.log('[install] registering agent against cws-core (POST /auth/register/agent)');
    let reg;
    try {
      reg = await registerAgent(envBff);
    } catch (err) {
      console.error('[install] ✗ registration failed:', err.message);
      process.exit(1);
    }
    config.agent.identity_id = reg.identity_id;
    config.agent.api_key     = reg.api_key;
    console.log(`[install] ✓ registered: identity_id=${reg.identity_id}`);
  }

  for (const orgId of envOrgIds) seedOrg(orgId);
  if (envOrgIds.length === 0) {
    console.log('[install] no COCO_ORG_IDS provided — service will idle until orgs are configured');
  }
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log('[install] config.json written');

console.log('[install] complete');
if (isInteractive) {
  console.log('');
  console.log('Next steps:');
  console.log('  - Start the service:  pm2 start ecosystem.config.cjs');
  console.log('  - Watch the bootstrap: pm2 logs zylos-coco-workspace --lines 50');
}
