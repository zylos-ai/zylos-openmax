#!/usr/bin/env node

/**
 * Configure hook for zylos-coco-workspace.
 *
 * Invoked by `zylos add coco-workspace` after the operator answers the
 * config.required prompts. Receives the collected values as JSON on stdin,
 * shape: { COCO_BFF_URL, COCO_AGENT_TICKET, COCO_AGENT_NAME, COCO_ORG_ID,
 * COCO_SELF_MEMBER_ID, ... }.
 *
 * Strategy: copy the values into process.env, then delegate to
 * hooks/post-install.js. post-install's existing env-driven non-interactive
 * branch (see hook header) reads the same vars, registers the agent, and
 * writes config.json. Re-invocation by `zylos add`'s Step 7 is idempotent
 * (post-install short-circuits when config.agent.api_key is already set).
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

// Hand off to the env-driven post-install hook. Use a dynamic import so any
// errors surface as a normal exception (not a hidden module-load failure).
await import('./post-install.js');
