/**
 * Local disk store for cws-connect capability caches, all under one subtree:
 *
 *   runtime/connect/
 *   ├── connections-index.json          # connection → application (both modes)
 *   ├── action-catalog/<applicationId>.json   # application → capability (both modes)
 *   └── credentials/<connectionId>.json  # real access_token — direct/token mode only
 *                                        #   (owned by credential-cache.js)
 *
 * This module owns the first two (the mode-agnostic *discovery* layer):
 *   - the connections index — resolve an application → its connectionId + status,
 *     the entry point of every call (the agent starts from an app, not a
 *     connection). Maintained from connection.* WS events and refreshable from
 *     `conn.list`.
 *   - the action catalog — an app-keyed cache of the action metadata
 *     (`{toolkit, action, method, description, params, input_schema}`) returned
 *     by `GET /connect/applications/{id}/actions`. Filled on demand, invalidated
 *     by TTL or an explicit refresh; the endpoint returns no version/etag today
 *     (see references/conn-operations.md) so freshness is TTL + error-driven.
 *
 * Pure filesystem I/O — no network. `conn.js` orchestrates network + store.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

export const CONNECT_DIR = path.join(RUNTIME_DIR, 'connect');
export const INDEX_PATH = path.join(CONNECT_DIR, 'connections-index.json');
export const CATALOG_DIR = path.join(CONNECT_DIR, 'action-catalog');

/**
 * Per-org connections index path. The comm-bridge runs a WS per enabled org and
 * connections belong to a specific org, so the index MUST be org-scoped —
 * otherwise a multi-org agent connected to the same app (e.g. notion) in two orgs
 * could resolve the wrong org's connection. The action catalog stays global
 * (keyed by applicationId) because an application's capabilities are the same
 * across orgs.
 */
export function indexPathForOrg(orgId, dir = CONNECT_DIR) {
  return path.join(dir, `connections-index.${orgId}.json`);
}

/** Default catalog freshness window: 24h. */
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

export function ensureConnectDir(dir = CONNECT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

// ---------------------------------------------------------------------------
//  Connections index (connectionId → application)
// ---------------------------------------------------------------------------

/** Read the index as { connections: { [connectionId]: entry } }. Missing → empty. */
export function readIndex(indexPath = INDEX_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (data && typeof data === 'object' && data.connections && typeof data.connections === 'object') {
      return data;
    }
  } catch {}
  return { connections: {} };
}

function writeIndex(index, indexPath = INDEX_PATH) {
  ensureConnectDir(path.dirname(indexPath));
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
}

/**
 * Normalize one connection record (from a conn.list item or a connection event)
 * into the index entry shape. Returns null when there is no connection id.
 */
function toEntry(conn) {
  const id = conn.id || conn.connection_id;
  if (!id) return null;
  return {
    id,
    applicationId: conn.application_id || conn.applicationId || null,
    slug: conn.application_slug || conn.slug || conn.provider || null,
    name: conn.application_name || conn.name || null,
    status: conn.status || 'active',
  };
}

/**
 * Insert/update one connection in the index. Additive on unknown fields — a
 * later, richer record (e.g. from conn.list, carrying application_id/name) fills
 * gaps left by a sparser event-sourced upsert, and never nulls known values.
 */
export function upsertConnection(conn, indexPath = INDEX_PATH) {
  const entry = toEntry(conn);
  if (!entry) return null;
  const index = readIndex(indexPath);
  const prev = index.connections[entry.id] || {};
  index.connections[entry.id] = {
    id: entry.id,
    applicationId: entry.applicationId ?? prev.applicationId ?? null,
    slug: entry.slug ?? prev.slug ?? null,
    name: entry.name ?? prev.name ?? null,
    status: entry.status ?? prev.status ?? 'active',
  };
  writeIndex(index, indexPath);
  return index.connections[entry.id];
}

/** Remove one connection from the index (idempotent). */
export function removeConnection(connectionId, indexPath = INDEX_PATH) {
  const index = readIndex(indexPath);
  if (index.connections[connectionId]) {
    delete index.connections[connectionId];
    writeIndex(index, indexPath);
    return true;
  }
  return false;
}

/** Rebuild the index wholesale from a conn.list array (authoritative refresh). */
export function replaceIndexFromList(list, indexPath = INDEX_PATH) {
  const connections = {};
  for (const conn of Array.isArray(list) ? list : []) {
    const entry = toEntry(conn);
    if (entry) connections[entry.id] = entry;
  }
  writeIndex({ connections }, indexPath);
  return connections;
}

/**
 * Resolve an application → its connection entry. `app` may be an application
 * slug (e.g. "notion") or an applicationId (UUID). Prefers an active connection
 * when several match. Returns null when nothing matches.
 */
export function findConnectionByApp(app, indexPath = INDEX_PATH) {
  if (!app) return null;
  const entries = Object.values(readIndex(indexPath).connections);
  const matches = entries.filter((e) => e.slug === app || e.applicationId === app);
  if (matches.length === 0) return null;
  return matches.find((e) => e.status === 'active') || matches[0];
}

/**
 * Whether ANY connection, in ANY org's index, still references this application.
 *
 * The action catalog is GLOBAL (keyed by applicationId, shared across every org
 * and connection — see CATALOG_DIR), while the connections index is per-org. So
 * a caller deciding whether an app's shared catalog is now orphaned MUST scan
 * every org's index, not just the one the revoke arrived on: a connection to the
 * same app in another org must keep the shared catalog alive. Scans every
 * `connections-index.*.json` file under `dir`. Missing dir / no id → false.
 */
export function appHasAnyConnection(applicationId, dir = CONNECT_DIR) {
  if (!applicationId) return false;
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.startsWith('connections-index.') && f.endsWith('.json'));
  } catch {
    return false;
  }
  for (const f of files) {
    const index = readIndex(path.join(dir, f));
    for (const entry of Object.values(index.connections)) {
      if (entry.applicationId === applicationId) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
//  Action catalog (applicationId → capability metadata)
// ---------------------------------------------------------------------------

export function catalogPath(applicationId, dir = CATALOG_DIR) {
  return path.join(dir, `${applicationId}.json`);
}

/**
 * Read a cached catalog for an application. Returns { applicationId, actions,
 * fetchedAt } when present, else null. When `ttlMs` is given, a record older
 * than it is treated as a miss (returns null) so the caller refetches.
 */
export function readCatalog(applicationId, { ttlMs, dir = CATALOG_DIR, now = Date.now() } = {}) {
  try {
    const rec = JSON.parse(fs.readFileSync(catalogPath(applicationId, dir), 'utf8'));
    if (!rec || !Array.isArray(rec.actions)) return null;
    if (ttlMs != null && rec.fetchedAt && now - rec.fetchedAt > ttlMs) return null;
    return rec;
  } catch {
    return null;
  }
}

/** Persist an application's action catalog. `now` stamps fetchedAt (for TTL). */
export function writeCatalog(applicationId, actions, { dir = CATALOG_DIR, now = Date.now() } = {}) {
  ensureConnectDir(dir);
  const rec = { applicationId, fetchedAt: now, actions: Array.isArray(actions) ? actions : [] };
  fs.writeFileSync(catalogPath(applicationId, dir), JSON.stringify(rec, null, 2));
  return rec;
}

/** Drop one application's cached catalog (idempotent). */
export function invalidateCatalog(applicationId, dir = CATALOG_DIR) {
  try { fs.unlinkSync(catalogPath(applicationId, dir)); return true; } catch { return false; }
}
