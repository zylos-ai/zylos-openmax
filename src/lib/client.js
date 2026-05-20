/**
 * Shared HTTP client for all CLI modules.
 *
 * Uses Node.js 20+ native fetch with Bearer token authentication.
 * Aligned with cws-comm api-design.md §2:
 *   - Authorization: Bearer <session_token | api_key>
 *   - X-Workspace-Id:  <workspace_id>            (required)
 *   - X-Device-Id:     <device_id>               (recommended)
 *   - X-Client-Version: <semver>                 (recommended)
 *
 * Token resolution order (per request):
 *   1. setSessionToken(t)                — set explicitly by handshake
 *   2. ~/zylos/components/coco-workspace/runtime/session.json  (cross-process)
 *   3. process.env.COCO_AUTH_TOKEN       (long-lived API key fallback)
 *   4. config.agent.api_key              (api key from config)
 *
 * Base URL resolution:
 *   1. setBaseUrl(u)                     — explicit
 *   2. process.env.COCO_API_URL
 *   3. config.comm.api_url
 *   4. http://127.0.0.1:8080
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
import { loadSession } from './session.js';

let activeSessionToken = null;
let activeBaseUrl = null;
let activeHeaders = null;

export function setSessionToken(token) { activeSessionToken = token || null; }
export function setBaseUrl(url)        { activeBaseUrl = url || null; }
export function setHeaders(h)          { activeHeaders = h || null; }

function resolveBaseUrl() {
  if (activeBaseUrl) return activeBaseUrl;
  if (process.env.COCO_API_URL) return process.env.COCO_API_URL;
  const cfg = loadConfig();
  return cfg.comm?.api_url || 'http://127.0.0.1:8080';
}

function resolveToken() {
  if (activeSessionToken) return activeSessionToken;
  const sess = loadSession();
  if (sess?.session_token) return sess.session_token;
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
