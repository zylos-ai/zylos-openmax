/**
 * JWT token manager for cws-core auth flow.
 *
 * Three operations (cws-core auth.go):
 *
 *   exchange:   POST /auth/agent/token
 *               Authorization: Bearer <api_key>  (cwsk_xxx)
 *               Body: { org_id }
 *               → { access_token, access_token_expires_at,
 *                   refresh_token, refresh_token_expires_at }
 *
 *   refresh:    POST /auth/refresh
 *               Authorization: Bearer <access_token>
 *               Body: { refresh_token, org_id }
 *               → rotated token pair
 *
 *   wsTicket:   POST /auth/ws-ticket
 *               Authorization: Bearer <access_token>
 *               Body: { org_id }
 *               → { ticket, expires_at }  (30s TTL, one-time)
 *
 * Per-org caching: access_tokens are bound to a specific org_id, so we
 * cache state in a Map keyed by org_id. Disk persistence likewise lives at
 *   runtime/tokens/<org_id>.json
 *
 * No dependency on client.js — uses raw fetch to avoid circular imports.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, resolveDefaultOrgId } from './config.js';

const HOME = process.env.HOME || '/tmp';
const TOKEN_DIR = path.join(HOME, 'zylos/components/coco-workspace/runtime/tokens');
const REFRESH_MARGIN_MS = 60_000;   // refresh when <60 s remain on access_token

// ── per-org in-memory cache ──────────────────────────────────────────────────
const _stateByOrg = new Map();
// Each value: { access_token, access_token_expires_at (ms),
//               refresh_token, refresh_token_expires_at (ms) }

// ── config helpers ────────────────────────────────────────────────────────────

function resolveApiKey() {
  // Canonical store: config.agent.api_key. No env-var or .env fallback.
  return loadConfig().agent?.api_key || '';
}

function resolveCoreUrl() {
  const cfg = loadConfig();
  const base = process.env.COCO_API_URL || cfg.server?.bff_url || cfg.comm?.core_url || 'http://127.0.0.1:8080';
  return base.replace(/\/$/, '');
}

function resolveOrgId(orgId) {
  if (orgId) return orgId;
  return resolveDefaultOrgId();
}

function tokenFile(orgId) {
  return path.join(TOKEN_DIR, `${orgId}.json`);
}

// ── raw HTTP helper (no auth dependency) ─────────────────────────────────────

async function corePost(endpoint, body, bearerToken) {
  const url = `${resolveCoreUrl()}${endpoint}`;
  const headers = { 'Content-Type': 'application/json' };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  if (!res.ok) {
    const msg = (data && typeof data === 'object'
      ? (data.detail || data.error || data.message)
      : null) || text || `HTTP ${res.status}`;
    const err = new Error(`${endpoint}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  return new Date(val).getTime() || 0;
}

// ── disk persistence (per-org) ───────────────────────────────────────────────

function readDisk(orgId) {
  try { return JSON.parse(fs.readFileSync(tokenFile(orgId), 'utf-8')); }
  catch { return null; }
}

function writeDisk(orgId, state) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    const tmp = `${tokenFile(orgId)}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, tokenFile(orgId));
  } catch (e) {
    console.warn(`[token] writeDisk(${orgId}) failed:`, e.message);
  }
}

// ── public API ────────────────────────────────────────────────────────────────

export async function exchange(orgIdArg) {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error('token.exchange: config.agent.api_key not set');
  const oid = resolveOrgId(orgIdArg);
  if (!oid) throw new Error('token.exchange: org_id required (set COCO_ORG_ID or have exactly one enabled org)');
  const raw = await corePost('/auth/agent/token', { org_id: oid }, apiKey);
  // cws-core wraps auth responses in D8 envelope: { data: {...}, request_id, server_time }
  const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
  const state = {
    access_token:             d.access_token,
    access_token_expires_at:  toMs(d.access_token_expires_at),
    refresh_token:            d.refresh_token,
    refresh_token_expires_at: toMs(d.refresh_token_expires_at),
  };
  _stateByOrg.set(oid, state);
  writeDisk(oid, state);
  return state.access_token;
}

export async function refresh(orgIdArg) {
  const oid = resolveOrgId(orgIdArg);
  if (!oid) throw new Error('token.refresh: org_id required');
  let s = _stateByOrg.get(oid) || readDisk(oid);
  if (!s?.refresh_token) return exchange(oid);
  try {
    const body = { refresh_token: s.refresh_token, org_id: oid };
    const raw = await corePost('/auth/refresh', body, s.access_token);
    const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
    const state = {
      access_token:             d.access_token,
      access_token_expires_at:  toMs(d.access_token_expires_at),
      refresh_token:            d.refresh_token ?? s.refresh_token,
      refresh_token_expires_at: toMs(d.refresh_token_expires_at) || s.refresh_token_expires_at,
    };
    _stateByOrg.set(oid, state);
    writeDisk(oid, state);
    return state.access_token;
  } catch (err) {
    console.warn(`[token] refresh(${oid}) failed, re-exchanging with api_key:`, err.message);
    return exchange(oid);
  }
}

export async function getAccessToken(orgIdArg) {
  const oid = resolveOrgId(orgIdArg);
  if (!oid) throw new Error('token.getAccessToken: org_id required (set COCO_ORG_ID or have exactly one enabled org)');
  let s = _stateByOrg.get(oid);
  if (!s) {
    s = readDisk(oid);
    if (s) _stateByOrg.set(oid, s);
  }
  const now = Date.now();
  if (s?.access_token && s.access_token_expires_at - now > REFRESH_MARGIN_MS) {
    return s.access_token;
  }
  if (s?.refresh_token) return refresh(oid);
  return exchange(oid);
}

export async function getWsTicket(orgIdArg) {
  const oid = resolveOrgId(orgIdArg);
  if (!oid) throw new Error('token.getWsTicket: org_id required');
  const accessToken = await getAccessToken(oid);
  const raw = await corePost('/auth/ws-ticket', { org_id: oid }, accessToken);
  const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
  if (!d.ticket) throw new Error('token.getWsTicket: server returned no ticket');
  return d.ticket;
}

/**
 * Invalidate the cached token for a specific org (e.g. after WS 4003).
 * If no orgId is passed, clears the entire cache.
 */
export function invalidate(orgIdArg) {
  if (!orgIdArg) {
    _stateByOrg.clear();
    return;
  }
  _stateByOrg.delete(orgIdArg);
}
