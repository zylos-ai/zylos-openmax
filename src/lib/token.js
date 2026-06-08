/**
 * JWT token manager for cws-core auth flow.
 *
 * Three operations (cws-core auth.go):
 *
 *   exchange:   POST /auth/agent/token
 *               Authorization: Bearer <api_key>  (cwsk_xxx)
 *               Body: { org_id? }                 (empty body == identity-only JWT)
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
 *               Body: { org_id }   (server requires org-scoped JWT)
 *               → { ticket, expires_at }  (30s TTL, one-time)
 *
 * Per-org caching: access_tokens are bound to a specific org_id, so we
 * cache state in a Map keyed by org_id (or '' for identity-only). Disk
 * persistence likewise lives at runtime/tokens/<org_id|_identity>.json.
 *
 * Inflight Promise dedup: concurrent callers asking for the same org's JWT
 * share a single in-flight HTTP request — important on boot when N orgs spin
 * up at once and again when a CLI fan-outs several calls before the cache
 * is warm.
 *
 * Side-effect on first exchange: when org-scoped JWT comes back, we decode
 * the `member_id` claim and write it back into `config.orgs[slug].self.member_id`
 * if that field is empty. This lets interactive install skip asking the
 * operator for member_id — the agent learns its own identity from cws-core.
 *
 * No dependency on client.js — uses raw fetch to avoid circular imports.
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, resolveDefaultOrgId, updateConfig } from './config.js';
import { cfAccessHeaders } from './cf-access.js';

const HOME = process.env.HOME || '/tmp';
const TOKEN_DIR = path.join(HOME, 'zylos/components/coco-workspace/runtime/tokens');
const REFRESH_MARGIN_MS = 60_000;   // refresh when <60 s remain on access_token

const LOG = '[token]';

// ── per-org in-memory cache ──────────────────────────────────────────────────
const _stateByOrg = new Map();
// Each value: { access_token, access_token_expires_at (ms),
//               refresh_token, refresh_token_expires_at (ms),
//               member_id? (decoded from claims) }

// ── inflight Promise dedup (per cache key) ──────────────────────────────────
const _inflight = new Map();  // key → Promise

function withInflight(key, factory) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = factory().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ── config helpers ────────────────────────────────────────────────────────────

function resolveApiKey() {
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

function tokenFile(orgIdOrEmpty) {
  const safe = orgIdOrEmpty ? orgIdOrEmpty : '_identity';
  return path.join(TOKEN_DIR, `${safe}.json`);
}

// ── raw HTTP helper (no auth dependency) ─────────────────────────────────────
// RPC logging mirrors client.js: stdout controlled by COCO_RPC_LOG (default ON,
// '0' = off), file sink controlled by COCO_RPC_LOG_FILE (independent of
// stdout).

function rpcLogStdoutEnabled() {
  return process.env.COCO_RPC_LOG !== '0';
}
function rpcLogFilePath() {
  const p = process.env.COCO_RPC_LOG_FILE;
  return p && p.length > 0 ? p : null;
}
let _rpcLogFileEnsured = false;
function ensureRpcLogDir(filePath) {
  if (_rpcLogFileEnsured) return;
  try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch {}
  _rpcLogFileEnsured = true;
}
function appendRpcLine(line) {
  const filePath = rpcLogFilePath();
  if (!filePath) return;
  try {
    ensureRpcLogDir(filePath);
    fs.appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort */ }
}

async function corePost(endpoint, body, bearerToken) {
  const url = `${resolveCoreUrl()}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
    ...cfAccessHeaders(),
  };
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

  {
    const line = `[rpc] → POST ${url} req: ${JSON.stringify(body)}`;
    if (rpcLogStdoutEnabled()) console.log(line);
    appendRpcLine(line);
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  {
    const bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
    const line = `[rpc] ← POST ${url} resp ${res.status}: ${bodyStr}`;
    if (rpcLogStdoutEnabled()) {
      const level = res.status >= 400 ? 'warn' : 'log';
      console[level](line);
    }
    appendRpcLine(line);
  }

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

// ── JWT claim decoding (no signature check — for member_id extraction only) ─

function decodeJwtClaims(jwt) {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function writeBackMemberId(orgId, jwt) {
  if (!orgId || !jwt) return;
  const claims = decodeJwtClaims(jwt);
  const memberId = claims?.member_id || claims?.mid;
  if (!memberId) return;
  const cfg = loadConfig();
  for (const [slug, org] of Object.entries(cfg.orgs || {})) {
    if (org?.org_id !== orgId) continue;
    if (org.self?.member_id) return;       // already set, leave it
    updateConfig((c) => {
      const o = c.orgs?.[slug];
      if (!o) return;
      if (!o.self) o.self = { member_id: '', name: '' };
      if (!o.self.member_id) {
        o.self.member_id = memberId;
        console.error(`${LOG} auto-filled orgs.${slug}.self.member_id from JWT claims: ${memberId}`);
      }
    });
    return;
  }
}

// ── disk persistence (per-org) ───────────────────────────────────────────────

function readDisk(orgIdOrEmpty) {
  try { return JSON.parse(fs.readFileSync(tokenFile(orgIdOrEmpty), 'utf-8')); }
  catch { return null; }
}

function writeDisk(orgIdOrEmpty, state) {
  try {
    fs.mkdirSync(TOKEN_DIR, { recursive: true });
    const tmp = `${tokenFile(orgIdOrEmpty)}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, tokenFile(orgIdOrEmpty));
  } catch (e) {
    console.warn(`${LOG} writeDisk(${orgIdOrEmpty || '_identity'}) failed:`, e.message);
  }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Exchange api_key for a fresh JWT pair. Pass orgId='' (or omit) for an
 * identity-only JWT (no org context). Pass a real orgId for an org-scoped
 * JWT (server validates active membership; 401 if missing).
 */
export async function exchange(orgIdArg) {
  const oid = orgIdArg || '';                  // '' == identity-only
  return withInflight(`exchange:${oid}`, async () => {
    const apiKey = resolveApiKey();
    if (!apiKey) throw new Error('token.exchange: config.agent.api_key not set');
    const body = oid ? { org_id: oid } : {};
    console.error(`${LOG} exchange org=${oid || '(identity-only)'}`);
    const raw = await corePost('/auth/agent/token', body, apiKey);
    const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
    const state = {
      access_token:             d.access_token,
      access_token_expires_at:  toMs(d.access_token_expires_at),
      refresh_token:            d.refresh_token,
      refresh_token_expires_at: toMs(d.refresh_token_expires_at),
    };
    _stateByOrg.set(oid, state);
    writeDisk(oid, state);
    if (oid) writeBackMemberId(oid, state.access_token);
    console.error(`${LOG} exchange ok org=${oid || '(identity-only)'} exp=${new Date(state.access_token_expires_at).toISOString()}`);
    return state.access_token;
  });
}

export async function refresh(orgIdArg) {
  const oid = orgIdArg || '';
  return withInflight(`refresh:${oid}`, async () => {
    let s = _stateByOrg.get(oid) || readDisk(oid);
    if (!s?.refresh_token) return exchange(oid);
    try {
      const body = oid ? { refresh_token: s.refresh_token, org_id: oid }
                       : { refresh_token: s.refresh_token };
      console.error(`${LOG} refresh org=${oid || '(identity-only)'}`);
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
      if (oid) writeBackMemberId(oid, state.access_token);
      console.error(`${LOG} refresh ok org=${oid || '(identity-only)'} exp=${new Date(state.access_token_expires_at).toISOString()}`);
      return state.access_token;
    } catch (err) {
      console.warn(`${LOG} refresh(${oid || '_identity'}) failed, re-exchanging with api_key:`, err.message);
      return exchange(oid);
    }
  });
}

/**
 * Return a valid access token for the given org (or identity-only when orgId
 * is empty). Uses the cache when possible; falls through to refresh/exchange.
 *
 * IMPORTANT: callers that need an org-scoped JWT (e.g. before ws-ticket) must
 * pass a non-empty orgId. Callers that explicitly want identity-only (e.g.
 * org-create flow) should pass '' or omit.
 */
export async function getAccessToken(orgIdArg) {
  const oid = orgIdArg || '';
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
  if (!oid) throw new Error('token.getWsTicket: org_id required (no default org configured)');
  const accessToken = await getAccessToken(oid);
  console.error(`${LOG} ws-ticket org=${oid}`);
  const raw = await corePost('/auth/ws-ticket', { org_id: oid }, accessToken);
  const d = (raw && typeof raw === 'object' && raw.data) ? raw.data : raw;
  if (!d.ticket) throw new Error('token.getWsTicket: server returned no ticket');
  console.error(`${LOG} ws-ticket ok org=${oid}`);
  return d.ticket;
}

/**
 * Invalidate the cached token for a specific org (e.g. after WS 4003).
 * If no orgId is passed, clears the entire cache.
 */
export function invalidate(orgIdArg) {
  if (orgIdArg === undefined) {
    _stateByOrg.clear();
    return;
  }
  _stateByOrg.delete(orgIdArg || '');
}
