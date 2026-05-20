/**
 * Shared HTTP client for all REST calls.
 *
 * In this architecture all REST goes through cws-core (BFF), even for
 * functionality logically owned by cws-comm / cws-work / etc. — cws-core
 * forwards over gRPC internally. We therefore have ONE REST base URL
 * (cws-core) and the cws-comm WS session_token is NOT a REST credential
 * (it only authenticates WebSocket frames on the direct cws-comm link).
 *
 * Token resolution order for REST (per request):
 *   1. setApiKey(t)                  — set explicitly by caller
 *   2. process.env.COCO_AUTH_TOKEN   — long-lived API key
 *   3. config.agent.api_key          — same key, from config
 *
 * Base URL resolution:
 *   1. setBaseUrl(u)                 — explicit
 *   2. process.env.COCO_API_URL      — env override (deploy convenience)
 *   3. config.comm.core_url          — canonical config field
 *   4. http://127.0.0.1:8080         — dev fallback
 *
 * Headers attached on every request (cws-comm api-design §2):
 *   - Authorization: Bearer <api_key>
 *   - X-Workspace-Id  (required)
 *   - X-Device-Id     (recommended)
 *   - X-Client-Version (recommended)
 *
 * Method signatures (matches cws-work/zylos-tm):
 *   - get(path, query?)              GET with optional query params
 *   - post(path, body?)              POST with optional JSON body
 *   - patch(path, body?)             PATCH with optional JSON body
 *   - put(path, body?)               PUT with optional JSON body
 *   - del(path)                      DELETE
 *
 * On success: returns parsed JSON (or raw text if response is not JSON).
 * On HTTP error: throws Error whose .message is the server's error detail
 * and .status carries the HTTP status code.
 */

import { loadConfig } from './config.js';

let activeApiKey = null;
let activeBaseUrl = null;
let activeHeaders = null;

export function setApiKey(token)  { activeApiKey = token || null; }
export function setBaseUrl(url)   { activeBaseUrl = url || null; }
export function setHeaders(h)     { activeHeaders = h || null; }

// Back-compat alias — older callers expected setSessionToken; deprecated.
export const setSessionToken = setApiKey;

function resolveBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
  const cfg = loadConfig();
  return cfg.comm?.core_url || cfg.comm?.api_url || 'http://127.0.0.1:8080';
}

function resolveToken() {
  if (activeApiKey) return activeApiKey;
  if (process.env.COCO_AUTH_TOKEN) return process.env.COCO_AUTH_TOKEN;
  const cfg = loadConfig();
  return cfg.agent?.api_key || '';
}

function resolveHeaders() {
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

function buildUrl(path, query) {
  const base = resolveBaseUrl().replace(/\/$/, '');
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

async function request(method, path, { body, query, extraHeaders } = {}) {
  const url = buildUrl(path, query);
  const headers = { Accept: 'application/json', ...resolveHeaders(), ...(extraHeaders || {}) };
  const token = resolveToken();
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

export const get   = (path, query) => request('GET',    path, { query });
export const post  = (path, body)  => request('POST',   path, { body });
export const patch = (path, body)  => request('PATCH',  path, { body });
export const put   = (path, body)  => request('PUT',    path, { body });
export const del   = (path)        => request('DELETE', path);
