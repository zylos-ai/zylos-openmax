#!/usr/bin/env node

/**
 * Configure hook for zylos-coco-workspace.
 *
 * Invoked by `zylos add coco-workspace` after the operator answers the
 * config.required prompts. Receives the collected values as JSON on stdin.
 *
 * Expected shape (v0.3 — register-agent contract aligned with cws-core):
 *   {
 *     "COCO_BFF_URL":     "https://cws-int.coco.xyz",
 *     "COCO_WS_URL":      "wss://cws-int.coco.xyz/ws",    // optional
 *     "COCO_ORG_IDS":     "uuid1,uuid2",                   // optional
 *     // BYO-agent (all three or none):
 *     "COCO_IDENTITY_ID": "...",                           // optional
 *     "COCO_API_KEY":     "cwsk_...",                      // optional
 *     "COCO_MEMBER_ID":   "..."                            // optional
 *   }
 *
 * Strategy: copy the values into process.env, then delegate to
 * hooks/post-install.js. post-install's non-interactive branch reads the same
 * vars, registers the agent, and writes config.json.
 *
 * This indirection avoids reintroducing a .env round-trip — the canonical
 * store remains config.json (no .env reads/writes in coco-workspace runtime
 * code; see v0.2.1).
 */

import { readFileSync } from 'node:fs';

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
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

for (const [key, val] of Object.entries(values)) {
  if (val != null && val !== '') process.env[key] = String(val);
}

await import('./post-install.js');
