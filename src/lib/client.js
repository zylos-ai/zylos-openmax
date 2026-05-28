/**
 * Shared HTTP client for all REST calls.
 *
 * zylos-coco-workspace targets THREE different backend services:
 *
 *   - cws-core  → /me, /members, /agents, /projects, /tasks, /issues,
 *                 /conversations, /conversations/{id}/messages
 *                 base URL  : comm.core_url
 *                 scope hdr : X-Workspace-Id
 *
 *   - cws-kb    → /api/v1/kbs/init, /api/v1/orgs/{orgId}/*
 *                 base URL  : comm.kb_url
 *                 scope hdr : X-Org-Id  (also embedded in path today)
 *
 *   - cws-as    → /api/v1/artifacts/*
 *                 base URL  : comm.as_url
 *                 scope hdr : X-Org-Id
 *
 * All three share ONE bearer credential — the agent's api_key. The cws-core
 * helpers (get/post/...) preserve the original module-global behavior;
 * cws-kb and cws-as get their own service-bound clients via kbClient() /
 * asClient() factories.
 *
 * Token resolution order (per request):
 *   1. setApiKey(t)                  — set explicitly by caller
 *   2. process.env.COCO_AUTH_TOKEN   — long-lived API key
 *   3. config.agent.api_key          — same key, from config
 *
 * On success: returns parsed JSON (or raw text if response is not JSON).
 * On HTTP error: throws Error whose .message is the server's error detail
 * and .status carries the HTTP status code.
 */

import { loadConfig } from './config.js';
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
// ============================================================================

function resolveBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
  const cfg = loadConfig();
  return cfg.comm?.core_url || cfg.comm?.api_url || 'http://127.0.0.1:8080';
}

function resolveKbBaseUrl() {
  if (process.env.COCO_KB_URL) return process.env.COCO_KB_URL;
  const cfg = loadConfig();
  return cfg.comm?.kb_url || resolveBaseUrl();
}

function resolveAsBaseUrl() {
  if (process.env.COCO_AS_URL) return process.env.COCO_AS_URL;
  const cfg = loadConfig();
  return cfg.comm?.as_url || resolveBaseUrl();
}

function resolveOrgId() {
  if (process.env.COCO_ORG_ID) return process.env.COCO_ORG_ID;
  const cfg = loadConfig();
  return cfg.org_id || '';
}

async function resolveToken() {
  // Prefer an explicitly-set override (tests / one-shot CLI invocations).
  if (activeApiKey) return activeApiKey;
  // Use the token manager: returns a cached or freshly-refreshed JWT.
  // Falls back to api_key if token.js cannot reach cws-core (e.g. offline).
  try {
    return await getAccessToken();
  } catch {
    if (process.env.COCO_AUTH_TOKEN) return process.env.COCO_AUTH_TOKEN;
    return loadConfig().agent?.api_key || '';
  }
}

function resolveCoreHeaders() {
  if (activeHeaders) return activeHeaders;
  const cfg = loadConfig();
  const out = {};
  const workspaceId = cfg.workspace_id || process.env.COCO_WORKSPACE_ID || '';
  const deviceId    = cfg.device_id    || process.env.COCO_DEVICE_ID    || '';
  const version     = cfg.app_version  || process.env.COCO_CLIENT_VERSION || '';
  if (workspaceId) out['X-Workspace-Id']   = workspaceId;
  if (deviceId)    out['X-Device-Id']      = deviceId;
  if (version)     out['X-Client-Version'] = version;
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
//  Service-bound clients (cws-kb, cws-as)
//
//  Each factory call resolves the service's base URL + X-Org-Id at call
//  time (so config hot-reload + env override both work). Returned object
//  has the same {get, post, patch, put, del} surface as the module-global
//  helpers; no apiPath wrapping (paths are written explicitly because the
//  KB/AS routes are too varied for a single prefix to be helpful).
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
 * Service-bound client for cws-kb.
 *
 * @param {string} [orgId]  override the resolved org id (else uses config.org_id / COCO_ORG_ID)
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
  return makeClient(resolveKbBaseUrl(), headers);
}

/**
 * Service-bound client for cws-as.
 *
 * @param {string} [orgId]  override the resolved org id
 */
export function asClient(orgId) {
  const headers = {};
  const oid = orgId || resolveOrgId();
  if (oid) headers['X-Org-Id'] = oid;
  return makeClient(resolveAsBaseUrl(), headers);
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
