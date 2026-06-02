#!/usr/bin/env node

/**
 * Configure hook — narrow responsibility: persist the values prompted by
 * `zylos add coco-workspace` into config.json's `server` block. Does NOT
 * register the agent or seed orgs — those steps belong to the post-install
 * hook so that the interactive (TTY) flow can ask for BYO agent identity
 * and org_ids without being short-circuited by an api_key that this hook
 * eagerly wrote.
 *
 * Stdin shape (JSON):
 *   {
 *     "COCO_BFF_URL":     "https://...",   // required
 *     "COCO_WS_URL":      "wss://.../ws"   // optional
 *     // BYO + org seeding are accepted but post-install owns those —
 *     // pass them here too so they're available to either install path:
 *     "COCO_IDENTITY_ID": "...",
 *     "COCO_API_KEY":     "cwsk_...",
 *     "COCO_MEMBER_ID":   "...",
 *     "COCO_ORG_IDS":     "uuid1,uuid2"
 *   }
 *
 * What this hook does:
 *   1. Read the stdin JSON.
 *   2. Persist COCO_BFF_URL / COCO_WS_URL into config.server.{bff_url,ws_url}.
 *   3. Re-export every value as a process env var so that when zylos-core
 *      runs the post-install hook next *within the same parent process*,
 *      those vars are visible. (For zylos-core's actual implementation,
 *      this is a no-op — env doesn't cross process boundaries — but the
 *      stdin JSON is the source of truth either way.)
 *
 * post-install (TTY mode) reads config.server defaults from the file we
 * just wrote, then prompts for BYO agent identity and org_ids. post-install
 * (non-TTY env-driven mode, K8s prepare-job) uses the env vars directly.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_CONFIG } from '../src/lib/config.js';

const HOME = process.env.HOME;
const DATA_DIR    = path.join(HOME, 'zylos/components/coco-workspace');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

let raw = '';
try {
  raw = fs.readFileSync(0, 'utf8');
} catch {
  // No stdin — treat as empty values
}

let values = {};
if (raw.trim()) {
  try {
    values = JSON.parse(raw);
  } catch (err) {
    console.error('[configure] stdin is not valid JSON:', err.message);
    process.exit(1);
  }
}

// Re-export every value so direct-import flows (and same-process callers)
// can still see them. Most install pipelines run hooks in separate processes,
// so this is mostly defensive — the canonical channel is still stdin JSON.
for (const [key, val] of Object.entries(values)) {
  if (val != null && val !== '') process.env[key] = String(val);
}

// Load current config (or seed defaults) and write server endpoints.
fs.mkdirSync(DATA_DIR, { recursive: true });

let config;
try {
  config = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
} catch {
  config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
}

if (!config.server) config.server = {};

const bff = (values.COCO_BFF_URL || '').replace(/\/$/, '');
const ws  = values.COCO_WS_URL || '';

if (bff) config.server.bff_url = bff;
if (ws)  config.server.ws_url  = ws;
if (!config.server.ws_url && config.server.bff_url) {
  config.server.ws_url = config.server.bff_url.replace(/^http/, 'ws') + '/ws';
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
console.log(`[configure] endpoints persisted: bff_url=${config.server.bff_url || '(unset)'} ws_url=${config.server.ws_url || '(unset)'}`);
console.log('[configure] agent registration + org seeding deferred to post-install hook');
