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
 * The helpers are organised into:
 *   - get/post/patch/put/del : core endpoints (D8 envelope unwrapped)
 *   - kbClient(orgId)        : pre-bound with X-Org-Id, no envelope unwrap
 *   - asClient(orgId)        : pre-bound with X-Org-Id, no envelope unwrap
 *
 * Both kbClient and asClient hit the same bff_url; the factories exist so
 * callers don't have to repeat the X-Org-Id header injection.
 *
 * Token resolution order (per request):
 *   1. setApiKey(t)            — set explicitly by caller (tests / one-shot CLI)
 *   2. config.agent.api_key    — canonical store (no env or .env fallback)
 *
 * On success: returns parsed JSON (or raw text if response is not JSON).
 * On HTTP error: throws Error whose .message is the server's error detail
 * and .status carries the HTTP status code.
 */

import { loadConfig, resolveDefaultOrgId } from './config.js';
import { getAccessToken } from './token.js';

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
//
//  Config schema v0.4 uses `server.*` (new) instead of `comm.*` (legacy).
//  We try the new path first and fall back to the legacy path so a config
//  that hasn't been migrated yet still works.
// ============================================================================

function resolveBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
  const cfg = loadConfig();
  return cfg.server?.bff_url
      || cfg.comm?.core_url || cfg.comm?.api_url
      || 'http://127.0.0.1:8080';
}

function resolveOrgId() {
  return resolveDefaultOrgId();
}

async function resolveToken() {
  // Prefer an explicitly-set override (tests / one-shot CLI invocations).
  if (activeApiKey) return activeApiKey;
  // Use the token manager: returns a cached or freshly-refreshed JWT.
  // Falls back to api_key if token.js cannot reach cws-core (e.g. offline).
  try {
    return await getAccessToken();
  } catch {
    return loadConfig().agent?.api_key || '';
  }
}

function resolveCoreHeaders() {
  if (activeHeaders) return activeHeaders;
  const cfg = loadConfig();
  const out = {};
  // workspace_id was dropped in the v0.4 multi-org refactor; org scoping is
  // expressed via X-Org-Id (on kb/as) and via per-org WS connections.
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

async function doRequest(baseUrl, method, path, { body, query, extraHeaders } = {}) {
  const url = buildUrl(baseUrl, path, query);
  const headers = { Accept: 'application/json', ...(extraHeaders || {}) };
  const token = await resolveToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }

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
  // cws-core@contract-v2 wraps every response in a D8 envelope:
  //   - single:     { data, request_id, server_time }
  //   - paginated:  { data, pagination, request_id, server_time }
  // Strip request_id / server_time (callers don't use them). For paginated
  // responses, preserve `pagination` alongside `data` so callers can page
  // through results. For single responses, unwrap straight to `data`.
  if (result && typeof result === 'object' && 'data' in result && 'request_id' in result) {
    if ('pagination' in result) {
      return { data: result.data, pagination: result.pagination };
    }
    return result.data;
  }
  return result;
}

export const get   = (path, query) => request('GET',    path, { query });
export const post  = (path, body)  => request('POST',   path, { body });
export const patch = (path, body)  => request('PATCH',  path, { body });
export const put   = (path, body)  => request('PUT',    path, { body });
export const del   = (path)        => request('DELETE', path);

/**
 * Prefix a logical path with the cws-core API prefix.
 *
 * cws-core exposes its surface under `/api/v1/*` (per the live OpenAPI
 * at https://zylos01.jinglever.com/cws-core/openapi.json). Override via
 * `COCO_API_PREFIX` to talk to a different deployment.
 */
export function apiPath(p) {
  const prefix = process.env.COCO_API_PREFIX ?? '/api/v1';
  return prefix + p;
}

// ============================================================================
//  Org-scoped clients for KB and AS routes
//
//  cws-core acts as the gateway for cws-kb and cws-as — the agent calls
//  /api/v1/orgs/{orgId}/* and /api/v1/artifacts/* against bff_url; cws-core
//  forwards server-side. These factories exist to pre-bind X-Org-Id and to
//  give callers an interface that doesn't D8-unwrap (KB/AS responses are
//  not enveloped). The returned client hits the same base URL as the
//  module-global get/post/... helpers.
// ============================================================================

function makeClient(baseUrl, scopeHeaders) {
  const wrap = (method) => (path, second) => {
    const opts = method === 'GET' ? { query: second } : { body: second };
    return doRequest(baseUrl, method, path, { ...opts, extraHeaders: scopeHeaders });
  };
  return {
    get:    wrap('GET'),
    post:   wrap('POST'),
    patch:  wrap('PATCH'),
    put:    wrap('PUT'),
    del:    (path) => doRequest(baseUrl, 'DELETE', path, { extraHeaders: scopeHeaders }),
    baseUrl,
    headers: scopeHeaders,
  };
}

/**
 * Org-scoped client for cws-kb routes (forwarded by cws-core gateway).
 *
 * @param {string} [orgId]  override the resolved org id (else uses COCO_ORG_ID,
 *                          or the single enabled org from config.orgs)
 * @returns {{get,post,patch,put,del,baseUrl,headers}}
 *
 * Example:
 *   const kb = kbClient();
 *   const tree = await kb.get(`/api/v1/orgs/${kb.headers['X-Org-Id']}/tree/roots`);
 */
export function kbClient(orgId) {
  const headers = {};
  const oid = orgId || resolveOrgId();
  if (oid) headers['X-Org-Id'] = oid;
  return makeClient(resolveBaseUrl(), headers);
}

/**
 * Org-scoped client for cws-as routes (forwarded by cws-core gateway).
 *
 * @param {string} [orgId]  override the resolved org id
 */
export function asClient(orgId) {
  const headers = {};
  const oid = orgId || resolveOrgId();
  if (oid) headers['X-Org-Id'] = oid;
  return makeClient(resolveBaseUrl(), headers);
}

// ============================================================================
//  Raw helpers (used by upload flows that need direct fetch)
// ============================================================================

/**
 * PUT raw bytes to an absolute (typically pre-signed) URL.
 * No Bearer header added — pre-signed URLs carry their own auth.
 *
 *   await putBytes(signedUrl, buf, 'application/pdf', { 'x-amz-server-side-encryption': 'AES256' })
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
