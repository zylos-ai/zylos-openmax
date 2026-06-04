/**
 * Shared HTTP client for all REST calls.
 *
 * The agent only talks to ONE REST surface: cws-core (server.bff_url).
 * cws-core acts as the gateway for cws-kb and cws-as — KB/AS routes are
 * forwarded server-side, not called directly.
 *
 *   - cws-core gateway → /me, /members, /agents, /projects, /tasks, /issues,
 *                        /conversations, /conversations/{id}/messages,
 *                        /api/v1/kbs/*, /api/v1/orgs/{orgId}/*,
 *                        /api/v1/artifacts/*
 *                        base URL  : server.bff_url
 *                        scope hdr : X-Org-Id (for kb/as paths)
 *
 * Multi-org JWT routing
 * ---------------------
 * Every request resolves its bearer token via `getAccessToken(orgId)`. When
 * the caller threads an `orgId` (kbClient/asClient factories, comm-bridge's
 * per-org REST helpers `getForOrg`/`postForOrg`/...), that org's cached JWT
 * is used. When `orgId` is omitted, we fall back to `resolveDefaultOrgId()`
 * (env COCO_ORG_ID, or the single enabled org). This keeps single-org
 * deployments and one-shot CLIs working without code changes, while
 * multi-org deployments get correctly-scoped tokens per request.
 *
 * Cloudflare Access (test env only): every request is also tagged with the
 * CF-Access-Client-Id / CF-Access-Client-Secret headers from `cf-access.js`.
 * Delete that import + spread when promoting to production.
 *
 * On success: returns parsed JSON (or raw text if response is not JSON).
 * On HTTP error: throws Error whose .message is the server's error detail
 * and .status carries the HTTP status code.
 */

import { loadConfig, resolveDefaultOrgId } from './config.js';
import { getAccessToken } from './token.js';
import { cfAccessHeaders } from './cf-access.js';

let activeApiKey = null;
let activeBaseUrl = null;
let activeHeaders = null;

export function setApiKey(token)  { activeApiKey = token || null; }
export function setBaseUrl(url)   { activeBaseUrl = url || null; }
export function setHeaders(h)     { activeHeaders = h || null; }

// Back-compat alias — older callers expected setSessionToken; deprecated.
export const setSessionToken = setApiKey;

// ============================================================================
//  Base URL / token / header resolution
// ============================================================================

function resolveBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
  const cfg = loadConfig();
  return cfg.server?.bff_url
      || cfg.comm?.core_url || cfg.comm?.api_url
      || 'http://127.0.0.1:8080';
}

async function resolveToken(orgId) {
  // Prefer an explicitly-set override (tests / one-shot CLI invocations).
  if (activeApiKey) return activeApiKey;
  // Use the token manager: returns a cached or freshly-refreshed JWT for
  // the given org. Falls back to the raw api_key if token.js cannot reach
  // cws-core (e.g. offline). Note: the api_key works as a bearer only on
  // /auth/agent/token — every other endpoint requires a real JWT.
  try {
    return await getAccessToken(orgId || resolveDefaultOrgId());
  } catch {
    return loadConfig().agent?.api_key || '';
  }
}

function resolveCoreHeaders() {
  if (activeHeaders) return activeHeaders;
  const cfg = loadConfig();
  const out = {};
  const deviceId = cfg.agent?.device_id || cfg.device_id || process.env.COCO_DEVICE_ID    || '';
  const version  = cfg.agent?.app_version || cfg.app_version || process.env.COCO_CLIENT_VERSION || '';
  if (deviceId) out['X-Device-Id']      = deviceId;
  if (version)  out['X-Client-Version'] = version;
  return out;
}

// ============================================================================
//  URL building
// ============================================================================

function buildUrl(baseUrl, path, query) {
  const base = (baseUrl || '').replace(/\/$/, '');
  let url = path.startsWith('http') ? path : `${base}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, String(v));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  if (qs) url += `?${qs}`;
  return url;
}

// ============================================================================
//  Generic request impl (baseUrl + headers injected by caller)
// ============================================================================

// Verbose RPC logging
// -------------------
// Two independent sinks:
//
//   1) stdout — controlled by COCO_RPC_LOG. Default ON; set to '0' to silence
//      stdout (smoke tests do this so test client output stays clean).
//
//   2) file   — controlled by COCO_RPC_LOG_FILE. When set to a path, every
//      RPC line is also appended there (best-effort, sync append, JSON-line
//      friendly). This is **independent of COCO_RPC_LOG** — file logging
//      stays on even when stdout is silenced, which is the integration-phase
//      ask: smoke tests run with stdout off but we still want full traces
//      on disk for post-mortem. Set to empty string or unset to disable.
//
// Tagged `[rpc]` for grep-friendliness.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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
  try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
  _rpcLogFileEnsured = true;
}
function appendRpcLine(line) {
  const filePath = rpcLogFilePath();
  if (!filePath) return;
  try {
    ensureRpcLogDir(filePath);
    appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`);
  } catch { /* best-effort: don't crash RPCs on disk errors */ }
}

function logRpcRequest(method, url, body, orgId) {
  const tag = orgId ? `org=${orgId}` : '';
  const bodyStr = body === undefined ? '(no body)' : JSON.stringify(body);
  const line = `[rpc] → ${method} ${url} ${tag} req: ${bodyStr}`;
  if (rpcLogStdoutEnabled()) console.log(line);
  appendRpcLine(line);
}

function logRpcResponse(method, url, status, data) {
  let bodyStr;
  try { bodyStr = typeof data === 'string' ? data : JSON.stringify(data); }
  catch { bodyStr = String(data); }
  const line = `[rpc] ← ${method} ${url} resp ${status}: ${bodyStr}`;
  if (rpcLogStdoutEnabled()) {
    const level = status >= 400 ? 'warn' : 'log';
    console[level](line);
  }
  appendRpcLine(line);
}

async function doRequest(baseUrl, method, path, { body, query, extraHeaders, orgId } = {}) {
  const url = buildUrl(baseUrl, path, query);
  const headers = {
    Accept: 'application/json',
    ...cfAccessHeaders(),
    ...(extraHeaders || {}),
  };
  const token = await resolveToken(orgId);
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  logRpcRequest(method, url, body, orgId);

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

  logRpcResponse(method, url, res.status, data);

  if (!res.ok) {
    const message =
      (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text;
    const err = new Error(message);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

// ============================================================================
//  cws-core client (module-global helpers — backward compatible)
// ============================================================================

async function request(method, path, opts = {}) {
  const result = await doRequest(resolveBaseUrl(), method, path, {
    ...opts,
    extraHeaders: { ...resolveCoreHeaders(), ...(opts.extraHeaders || {}) },
  });
  // cws-core wraps every response in a D8 envelope:
  //   - single:     { data, request_id, server_time }
  //   - paginated:  { data, pagination, request_id, server_time }
  if (result && typeof result === 'object' && 'data' in result && 'request_id' in result) {
    if ('pagination' in result) {
      return { data: result.data, pagination: result.pagination };
    }
    return result.data;
  }
  return result;
}

// Default-org variants (use COCO_ORG_ID env or single-enabled-org).
export const get   = (path, query) => request('GET',    path, { query });
export const post  = (path, body)  => request('POST',   path, { body });
export const patch = (path, body)  => request('PATCH',  path, { body });
export const put   = (path, body)  => request('PUT',    path, { body });
export const del   = (path)        => request('DELETE', path);

// Org-aware variants. Use these in any code path that knows which org it's
// running on (e.g. per-org WS message handlers, multi-org CLI commands).
// They resolve the JWT against that specific org's cache, so a multi-org
// agent never accidentally calls cws-core with the wrong org's token.
export const getForOrg   = (orgId, path, query) => request('GET',    path, { query, orgId });
export const postForOrg  = (orgId, path, body)  => request('POST',   path, { body,  orgId });
export const patchForOrg = (orgId, path, body)  => request('PATCH',  path, { body,  orgId });
export const putForOrg   = (orgId, path, body)  => request('PUT',    path, { body,  orgId });
export const delForOrg   = (orgId, path)        => request('DELETE', path, { orgId });

/**
 * Prefix a logical path with the cws-core API prefix.
 *
 * Override via COCO_API_PREFIX to talk to a different deployment.
 */
export function apiPath(p) {
  const prefix = process.env.COCO_API_PREFIX ?? '/api/v1';
  return prefix + p;
}

// ============================================================================
//  Org-scoped clients for KB and AS routes
// ============================================================================

function makeClient(baseUrl, scopeHeaders, orgId) {
  const wrap = (method) => (path, second) => {
    const opts = method === 'GET' ? { query: second } : { body: second };
    return doRequest(baseUrl, method, path, { ...opts, extraHeaders: scopeHeaders, orgId });
  };
  return {
    get:    wrap('GET'),
    post:   wrap('POST'),
    patch:  wrap('PATCH'),
    put:    wrap('PUT'),
    del:    (path) => doRequest(baseUrl, 'DELETE', path, { extraHeaders: scopeHeaders, orgId }),
    baseUrl,
    headers: scopeHeaders,
    orgId,
  };
}

/**
 * Org-scoped client for cws-kb routes (forwarded by cws-core gateway).
 *
 * @param {string} [orgId]  override the resolved org id (else uses COCO_ORG_ID,
 *                          or the single enabled org from config.orgs)
 */
export function kbClient(orgId) {
  const oid = orgId || resolveDefaultOrgId();
  const headers = oid ? { 'X-Org-Id': oid } : {};
  return makeClient(resolveBaseUrl(), headers, oid);
}

/**
 * Org-scoped client for cws-as routes (forwarded by cws-core gateway).
 */
export function asClient(orgId) {
  const oid = orgId || resolveDefaultOrgId();
  const headers = oid ? { 'X-Org-Id': oid } : {};
  return makeClient(resolveBaseUrl(), headers, oid);
}

// ============================================================================
//  Raw helpers (used by upload flows that need direct fetch)
// ============================================================================

/**
 * PUT raw bytes to an absolute (typically pre-signed) URL.
 * No Bearer / CF Access header added — pre-signed URLs carry their own auth
 * and target S3 directly, not cws-core via Cloudflare.
 */
export async function putBytes(url, buf, contentType, extraHeaders = {}) {
  const headers = { 'Content-Type': contentType || 'application/octet-stream', ...extraHeaders };
  const res = await fetch(url, { method: 'PUT', headers, body: buf });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`PUT ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return { ok: true, status: res.status };
}

/**
 * GET raw bytes from an absolute URL. Used to follow pre-signed download
 * URLs returned by cws-as.
 */
export async function getBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${res.status}: ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}
