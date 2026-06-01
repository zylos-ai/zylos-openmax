#!/usr/bin/env node

/**
 * Post-upgrade hook for zylos-coco-workspace.
 *
 * Handles the v0.3 → v0.4 (multi-org) schema migration:
 *   - top-level `workspace_id`                  → DROPPED
 *   - top-level `org_id`                        → orgs.default.org_id
 *   - top-level `device_id` / `client_id`
 *     / `app_version`                           → agent.*
 *   - top-level `comm.*`                        → server.* (subset)
 *       comm.core_url   → server.bff_url
 *       comm.ws_url     → server.ws_url
 *       comm.reconnect_max_delay / heartbeat_interval / platform → server.*
 *       comm.kb_url / comm.as_url               → DROPPED (cws-core is the
 *                                                  gateway; agent does not
 *                                                  talk to kb/as directly)
 *   - top-level `agent.identity_id` / `api_key` — preserved (still global)
 *   - new top-level `orgs.<slug>`               — wraps the legacy single-org
 *                                                 settings into `orgs.default`
 *
 * After migration the operator must:
 *   1. Verify `orgs.default.member_id` (was not in v0.3 schema — set to
 *      the agent's member_id within this org, or run a /me probe).
 *   2. Configure `orgs.default.access` (dmPolicy / groupPolicy / groups{}).
 *
 * The hook is idempotent: re-running on an already-migrated config is a no-op.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const CONFIG_PATH = path.join(HOME, 'zylos/components/coco-workspace/config.json');

let raw = '';
try {
  raw = fs.readFileSync(CONFIG_PATH, 'utf8');
} catch (e) {
  console.error(`[post-upgrade] failed to read ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}

let config;
try {
  config = JSON.parse(raw);
} catch (e) {
  console.error(`[post-upgrade] config.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

const legacyKeysSeen = [];

// ── server.* ────────────────────────────────────────────────────────────────
if (!config.server) config.server = {};
if (config.comm) {
  const m = config.comm;
  const map = {
    bff_url: m.core_url || m.api_url,
    ws_url:  m.ws_url,
    reconnect_max_delay: m.reconnect_max_delay,
    heartbeat_interval:  m.heartbeat_interval,
    platform: m.platform,
  };
  for (const [k, v] of Object.entries(map)) {
    if (v !== undefined && config.server[k] === undefined) config.server[k] = v;
  }
  if (m.kb_url !== undefined || m.as_url !== undefined) {
    legacyKeysSeen.push('comm.kb_url / comm.as_url (dropped — cws-core is the gateway)');
  }
  legacyKeysSeen.push('comm.* → server.* (kb/as dropped)');
  delete config.comm;
}

// Existing v0.4-shape configs that already migrated but kept server.kb_url /
// server.as_url around: drop them now since they're unused.
if (config.server) {
  let strippedKb = false;
  if (config.server.kb_url !== undefined) { delete config.server.kb_url; strippedKb = true; }
  if (config.server.as_url !== undefined) { delete config.server.as_url; strippedKb = true; }
  if (strippedKb) legacyKeysSeen.push('server.kb_url / server.as_url (dropped — unused)');
}

// ── agent.{device_id, client_id, app_version} ───────────────────────────────
if (!config.agent) config.agent = {};
for (const k of ['device_id', 'client_id', 'app_version']) {
  if (config[k] !== undefined) {
    if (config.agent[k] === undefined) config.agent[k] = config[k];
    legacyKeysSeen.push(k);
    delete config[k];
  }
}

// ── orgs.default from legacy top-level org_id ───────────────────────────────
if (!config.orgs) config.orgs = {};
if (config.org_id) {
  if (!config.orgs.default) {
    config.orgs.default = {
      enabled: true,
      org_id: config.org_id,
      org_name: '',
      member_id: '',                       // ← operator must fill in
      display_name: 'Zylos',
      owner: { bound: false, member_id: '', name: '' },
      access: {
        dmPolicy:    'owner',
        dmAllowFrom: [],
        groupPolicy: 'allowlist',
        groups:      {},
      },
    };
  }
  legacyKeysSeen.push('org_id');
  delete config.org_id;
}

// ── drop workspace_id entirely ──────────────────────────────────────────────
if (config.workspace_id !== undefined) {
  legacyKeysSeen.push('workspace_id (dropped — no replacement)');
  delete config.workspace_id;
}

// ── agent.id (legacy alias for identity_id) → identity_id ──────────────────
if (config.agent.id && !config.agent.identity_id) {
  config.agent.identity_id = config.agent.id;
  legacyKeysSeen.push('agent.id → agent.identity_id');
}
if (config.agent.id !== undefined) {
  delete config.agent.id;
}
// agent.participant_id was vestigial; drop if empty.
if (config.agent.participant_id === '' || config.agent.participant_id === undefined) {
  delete config.agent.participant_id;
}

// ── write back if anything changed ──────────────────────────────────────────
if (legacyKeysSeen.length > 0) {
  const tmp = `${CONFIG_PATH}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
  fs.renameSync(tmp, CONFIG_PATH);

  console.log('[post-upgrade] config.json migrated to multi-org schema (v0.4).');
  console.log('  Legacy fields migrated:');
  for (const k of legacyKeysSeen) console.log(`    - ${k}`);
  console.log('');
  console.log('  ⚠ ACTION REQUIRED — edit ' + CONFIG_PATH);
  console.log('    1. orgs.default.member_id — set to this agent\'s member id within the org');
  console.log('       (look it up via cws-core /me, or call POST /orgs/{org_id}/members/me).');
  console.log('    2. orgs.default.access — configure the policy:');
  console.log('       - dmPolicy: "open" | "allowlist" | "owner"');
  console.log('       - dmAllowFrom: [] (used when dmPolicy=allowlist)');
  console.log('       - groupPolicy: "open" | "allowlist" | "disabled"');
  console.log('       - groups: { "<conv-uuid>": { name, mode: "mention"|"smart", allowFrom: ["*"] } }');
  console.log('    3. To add MORE orgs, copy `orgs.default` to `orgs.<slug>`, fill in org_id and');
  console.log('       member_id for that org. Each enabled org gets its own WebSocket connection.');
  console.log('');
  console.log('  Service must be restarted after editing:  pm2 restart zylos-coco-workspace');
} else {
  console.log('[post-upgrade] config.json already on multi-org schema — nothing to migrate.');
}
