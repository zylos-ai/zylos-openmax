/**
 * JWT token manager for cws-core auth flow.
 *
 * Three operations (cws-core auth.go):
 *
 *   exchange:   POST /auth/agent/token
 *               Authorization: Bearer <api_key>  (cwsk_xxx)
 *               Body: { org_id? }
 *               → { access_token, access_token_expires_at,
 *                   refresh_token, refresh_token_expires_at }
 *
 *   refresh:    POST /auth/refresh
 *               Authorization: Bearer <access_token>
 *               Body: { refresh_token, org_id? }
 *               → rotated token pair
 *
 *   wsTicket:   POST /auth/ws-ticket
 *               Authorization: Bearer <access_token>
 *               Body: { org_id }
 *               → { ticket, expires_at }  (30s TTL, one-time)
 *
 * Token state is cached in memory AND persisted to runtime/token.json so
 * short-lived CLI child processes can reuse valid tokens without a fresh
 * exchange on every call.
 *
 * No dependency on client.js — uses raw fetch to avoid circular imports.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig } from './config.js';

const HOME = process.env.HOME || '/tmp';
const TOKEN_PATH = path.join(HOME, 'zylos/components/coco-workspace/runtime/token.json');
const REFRESH_MARGIN_MS = 60_000;   // refresh when <60 s remain on access_token

// ── in-memory cache ───────────────────────────────────────────────────────────
let _state = null;
// Schema: { access_token, access_token_expires_at (ms), refresh_token, refresh_token_expires_at (ms) }

// ── config helpers ────────────────────────────────────────────────────────────

function resolveApiKey() {
  if (process.env.COCO_AUTH_TOKEN) return process.env.COCO_AUTH_TOKEN;
  const cfg = loadConfig();
  return cfg.agent?.api_key || '';
}

function resolveCoreUrl() {
  const base = process.env.COCO_API_URL || loadConfig().comm?.core_url || 'http://127.0.0.1:8080';
  return base.replace(/\/$/, '');
}

function resolveOrgId(orgId) {
  if (orgId) return orgId;
  if (process.env.COCO_ORG_ID) return process.env.COCO_ORG_ID;
  return loadConfig().org_id || '';
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

// ── date helpers ──────────────────────────────────────────────────────────────

function toMs(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  return new Date(val).getTime() || 0;
}

// ── disk persistence ──────────────────────────────────────────────────────────

function readDisk() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8')); }
  catch { return null; }
}

function writeDisk(state) {
  try {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    const tmp = `${TOKEN_PATH}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, TOKEN_PATH);
  } catch (e) {
    console.warn('[token] writeDisk failed:', e.message);
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Exchange api_key for a JWT. Called when no valid token exists on disk.
 * Returns the new access_token.
 */
export async function exchange(orgId) {
  const apiKey = resolveApiKey();
  if (!apiKey) throw new Error('token.exchange: COCO_AUTH_TOKEN / config.agent.api_key not set');
  const oid = resolveOrgId(orgId);
  const raw = await corePost('/auth/agent/token', oid ? { org_id: oid } : {}, apiKey);
  // cws-core wraps all auth responses in D8 envelope: { data: {...}, request_id, server_time }
  const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
  const state = {
    access_token:             d.access_token,
    access_token_expires_at:  toMs(d.access_token_expires_at),
    refresh_token:            d.refresh_token,
    refresh_token_expires_at: toMs(d.refresh_token_expires_at),
  };
  _state = state;
  writeDisk(state);
  return state.access_token;
}

/**
 * Renew tokens using the refresh_token. Falls back to exchange() if the
 * refresh_token is missing or the family has been revoked.
 */
export async function refresh(orgId) {
  const s = _state || readDisk();
  if (!s?.refresh_token) return exchange(orgId);
  const oid = resolveOrgId(orgId);
  try {
    const body = { refresh_token: s.refresh_token, ...(oid ? { org_id: oid } : {}) };
    const raw = await corePost('/auth/refresh', body, s.access_token);
    const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
    const state = {
      access_token:             d.access_token,
      access_token_expires_at:  toMs(d.access_token_expires_at),
      refresh_token:            d.refresh_token ?? s.refresh_token,
      refresh_token_expires_at: toMs(d.refresh_token_expires_at) || s.refresh_token_expires_at,
    };
    _state = state;
    writeDisk(state);
    return state.access_token;
  } catch (err) {
    console.warn('[token] refresh failed, re-exchanging with api_key:', err.message);
    return exchange(orgId);
  }
}

/**
 * Return a valid access_token. Refreshes or re-exchanges transparently.
 * Main entry point for all REST callers (via client.js).
 */
export async function getAccessToken(orgId) {
  if (!_state) _state = readDisk();

  const now = Date.now();
  if (_state?.access_token && _state.access_token_expires_at - now > REFRESH_MARGIN_MS) {
    return _state.access_token;
  }
  if (_state?.refresh_token) return refresh(orgId);
  return exchange(orgId);
}

/**
 * Fetch a one-time WebSocket ticket.
 * Ensures we have a valid access_token first, then calls /auth/ws-ticket.
 * Returns the ticket string only (TTL 30s, one-time — do not cache).
 */
export async function getWsTicket(orgId) {
  const accessToken = await getAccessToken(orgId);
  const oid = resolveOrgId(orgId);
  if (!oid) throw new Error('token.getWsTicket: org_id required (set config.org_id or COCO_ORG_ID)');
  const raw = await corePost('/auth/ws-ticket', { org_id: oid }, accessToken);
  const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
  if (!d.ticket) throw new Error('token.getWsTicket: server returned no ticket');
  return d.ticket;
}

/**
 * Invalidate the in-memory cache (e.g. after WS 4003 session-expired).
 * Next call to getAccessToken() will re-read disk or re-exchange.
 */
export function invalidate() {
  _state = null;
}
