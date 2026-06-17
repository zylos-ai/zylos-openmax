/**
 * Conversation → org mapping for multi-org CLI send.
 *
 * The PM2 comm-bridge service knows which org each conversation belongs to
 * (via the per-org WS connection). Stateless CLI processes (scripts/send.js)
 * don't — they need a persistent mapping to resolve the correct org-scoped
 * JWT. This module provides that shared mapping.
 *
 * File: <component>/runtime/conv-org-map.json
 * Shape: { [conversationId]: { orgId, ts } }
 *
 * Entries older than MAX_AGE_MS are pruned on every write to prevent
 * unbounded growth from stale conversations.
 */

import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
const MAP_PATH = path.join(HOME, 'zylos/components/coco-workspace/runtime/conv-org-map.json');

const MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let _cache = null;

function readMap() {
  try {
    const raw = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    // Migrate v1 format (plain orgId string) to v2 (object with ts)
    const map = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string') {
        map[k] = { orgId: v, ts: Date.now() };
      } else if (v && typeof v === 'object') {
        map[k] = v;
      }
    }
    return map;
  } catch {
    return {};
  }
}

function pruneStale(map) {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const k of Object.keys(map)) {
    if ((map[k].ts || 0) < cutoff) delete map[k];
  }
}

function persistMap(map) {
  try {
    fs.mkdirSync(path.dirname(MAP_PATH), { recursive: true });
    const tmp = `${MAP_PATH}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, MAP_PATH);
  } catch {
    // best-effort
  }
}

/**
 * Register a conversation → org mapping. Called by comm-bridge on every
 * inbound message. Prunes stale entries, then atomic-writes to disk.
 */
export function registerConvOrg(conversationId, orgId) {
  if (!conversationId || !orgId) return;
  const map = _cache || readMap();
  const existing = map[conversationId];
  if (existing && existing.orgId === orgId) {
    existing.ts = Date.now();
    _cache = map;
    return;
  }
  map[conversationId] = { orgId, ts: Date.now() };
  pruneStale(map);
  _cache = map;
  persistMap(map);
}

/**
 * Look up which org a conversation belongs to. Used by CLI send to resolve
 * the correct org-scoped token. Returns orgId or empty string.
 */
export function lookupConvOrg(conversationId) {
  if (!conversationId) return '';
  const map = readMap();
  const entry = map[conversationId];
  if (!entry) return '';
  return (typeof entry === 'string') ? entry : (entry.orgId || '');
}
