/**
 * Shared HTTP client for all CLI modules.
 *
 * Uses Node.js 20+ native fetch with Bearer token authentication.
 * Per DESIGN.md §4.1 / §6.2:
 *   - COCO_API_URL    base URL (default http://127.0.0.1:8080)
 *   - COCO_AUTH_TOKEN Bearer token (required for authenticated endpoints)
 *
 * Method signatures follow the convention battle-tested in cws-work/zylos-tm:
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

const BASE_URL = process.env.COCO_API_URL || 'http://127.0.0.1:8080';
const AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || '';

function buildUrl(path, query) {
  let url = path.startsWith('http') ? path : `${BASE_URL.replace(/\/$/, '')}${path}`;
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

async function request(method, path, { body, query } = {}) {
  const url = buildUrl(path, query);
  const headers = { 'Accept': 'application/json' };
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
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
    const message = (data && typeof data === 'object' && (data.detail || data.error || data.message)) || text;
    const err = new Error(message);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const get   = (path, query) => request('GET',    path, { query });
export const post  = (path, body)  => request('POST',   path, { body });
export const patch = (path, body) => request('PATCH',  path, { body });
export const put   = (path, body)  => request('PUT',    path, { body });
export const del   = (path)        => request('DELETE', path);
