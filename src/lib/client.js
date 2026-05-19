/**
 * Shared HTTP client for all CLI modules.
 * Uses Node.js 20+ native fetch with Bearer token authentication.
 */

const BASE_URL = process.env.COCO_API_URL || 'http://127.0.0.1:8080';
const AUTH_TOKEN = process.env.COCO_AUTH_TOKEN || '';

function buildUrl(path, query) {
  const url = new URL(path, BASE_URL);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        for (const v of value) url.searchParams.append(key, v);
      } else if (value !== undefined && value !== null) {
        url.searchParams.set(key, value);
      }
    }
  }
  return url.toString();
}

async function request(method, path, { body, query } = {}) {
  const url = buildUrl(path, query);
  const headers = { 'Accept': 'application/json' };

  if (AUTH_TOKEN) {
    headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;
  }

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    const message = data?.detail || data?.error || data?.message || text;
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }

  return data;
}

export const get = (path, opts) => request('GET', path, opts);
export const post = (path, opts) => request('POST', path, opts);
export const patch = (path, opts) => request('PATCH', path, opts);
export const put = (path, opts) => request('PUT', path, opts);
export const del = (path, opts) => request('DELETE', path, opts);
