/**
 * Direct-mode local-egress execution for cws-connect connections.
 *
 * For a `direct` connection this agent holds a real `access_token` in the local
 * credential cache and the action catalog carries a `url_template` (+ optional
 * `headers_template`) per action. This module takes an action slug + params and:
 *
 *   1. resolves the action definition from the LOCAL catalog,
 *   2. validates params against the action's `input_schema` (lenient — the
 *      authoritative check still runs provider/server-side),
 *   3. fills `{placeholder}` tokens in the url_template (path + query) from
 *      params, builds the JSON body from the *remaining* params, and injects
 *      `Authorization: Bearer <token>` plus any templated headers,
 *   4. makes the HTTP request FROM THIS HOST directly to the provider, and
 *   5. returns the SAME shape the server execute path returns —
 *      `{ status_code, headers, body }` — as a raw passthrough (the provider
 *      body is never transformed; the LLM reads it).
 *
 * SECURITY RED LINE: request assembly is code-driven from the catalog. The
 * caller/LLM only supplies `action` + `params`; it can NEVER supply a free-form
 * URL. The action name must resolve in the catalog and the URL can only be the
 * registered `url_template` expanded with schema-checked params.
 *
 * Token lifecycle (O4): OAuth tokens are refreshed proactively when near expiry
 * and reactively ONCE on a provider 401; api_key tokens are static (never
 * refreshed) and a 401 is surfaced to the user. Refresh = re-acquire via
 * cws-core (injected `acquire`) + re-save the local cache.
 *
 * Pure-ish: `fetch`, `acquire`, and `saveCache` are injectable so this is unit
 * testable without network or disk. No import-time side effects.
 */

import { redactSecrets } from './redact.js';

// Cap on the provider response we read into memory (mirrors the server-side
// 10MB read limit). A larger body is truncated (and flagged) rather than
// buffered without bound.
export const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

// Refresh an OAuth token this many ms BEFORE its stated expiry, so a request
// launched right at the edge does not race the clock.
export const DEFAULT_EXPIRY_SKEW_MS = 60 * 1000;

// Methods that carry a request body built from the leftover params.
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// ---------------------------------------------------------------------------
//  Catalog resolution
// ---------------------------------------------------------------------------

/**
 * Resolve an action slug ("toolkit-slug/action-name") to its catalog entry.
 * Matches on "<toolkit>/<action>" first (the canonical invoke form), then falls
 * back to a bare "<action>" match. Returns null when nothing matches.
 */
export function resolveActionDef(actions, actionSlug) {
  if (!Array.isArray(actions) || !actionSlug) return null;
  const exact = actions.find((a) => `${a.toolkit}/${a.action}` === actionSlug);
  if (exact) return exact;
  return actions.find((a) => a.action === actionSlug) || null;
}

// ---------------------------------------------------------------------------
//  Param validation (lenient — server remains the authority)
// ---------------------------------------------------------------------------

function typeMatches(value, type) {
  switch (type) {
    case 'string':  return typeof value === 'string';
    case 'number':  return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array':   return Array.isArray(value);
    case 'object':  return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'null':    return value === null;
    default:        return true; // unknown/compound type — don't block
  }
}

/**
 * Validate params against an action `input_schema` (JSON Schema, body-oriented).
 * Deliberately lenient: only enforces `required` presence and declared-property
 * types. `additionalProperties` is NOT enforced because the flat `params` object
 * mixes body fields with URL path/query placeholders (which the body schema does
 * not describe). Empty/absent schema → no validation (unknown, don't block).
 */
export function validateParams(params, schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return { ok: true, errors };
  const props = (schema.properties && typeof schema.properties === 'object') ? schema.properties : {};
  for (const req of Array.isArray(schema.required) ? schema.required : []) {
    if (params[req] === undefined || params[req] === null) errors.push(`missing required param "${req}"`);
  }
  for (const [k, v] of Object.entries(params || {})) {
    const p = props[k];
    if (p && p.type && v !== undefined && v !== null && !typeMatches(v, p.type)) {
      errors.push(`param "${k}" expected type ${p.type}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
//  Request assembly (code-driven from the catalog url_template)
// ---------------------------------------------------------------------------

function fillTemplateValue(str, params, consumed) {
  return String(str).replace(/\{([^}]+)\}/g, (_, key) => {
    consumed.add(key);
    const v = params[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/**
 * Build the concrete HTTP request from an action definition + params + token.
 * Returns { method, url, headers, body }. `body` is undefined when there is no
 * body to send. Throws (status 422) when the action has no url_template (catalog
 * too old for direct mode) or (status 400) when a required PATH placeholder has
 * no value.
 *
 * Placeholder rules:
 *   - PATH placeholders are required — a missing value is an error (a literal
 *     "{id}" must never reach the wire).
 *   - QUERY placeholders are optional — a missing value drops that whole
 *     key=value pair.
 *   - HEADER placeholders (from headers_template) fill from params too.
 *   - Any param NOT consumed by a placeholder becomes a body field (body
 *     methods only).
 */
export function assembleRequest(actionDef, params = {}, token) {
  if (!actionDef || typeof actionDef.url_template !== 'string' || !actionDef.url_template) {
    throw Object.assign(
      new Error('action has no url_template — local catalog is too old for direct execution (run conn.catalog {refresh:true})'),
      { status: 422 },
    );
  }
  const method = String(actionDef.method || 'GET').toUpperCase();
  const template = actionDef.url_template;
  const consumed = new Set();

  const qIdx = template.indexOf('?');
  const pathPart = qIdx >= 0 ? template.slice(0, qIdx) : template;
  const queryPart = qIdx >= 0 ? template.slice(qIdx + 1) : '';

  // Path placeholders — required.
  const path = pathPart.replace(/\{([^}]+)\}/g, (_, key) => {
    consumed.add(key);
    const v = params[key];
    if (v === undefined || v === null || v === '') {
      throw Object.assign(new Error(`missing required path param "${key}" for action ${actionDef.toolkit}/${actionDef.action}`), { status: 400 });
    }
    return encodeURIComponent(String(v));
  });

  // Query placeholders — optional (drop the pair when the value is absent).
  const outPairs = [];
  for (const pair of queryPart.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawV = eq >= 0 ? pair.slice(eq + 1) : '';
    const m = /^\{([^}]+)\}$/.exec(rawV);
    if (m) {
      const key = m[1];
      consumed.add(key);
      const v = params[key];
      if (v === undefined || v === null || v === '') continue; // optional query param omitted
      outPairs.push(`${k}=${encodeURIComponent(String(v))}`);
    } else {
      outPairs.push(pair); // static query segment
    }
  }
  const url = path + (outPairs.length ? `?${outPairs.join('&')}` : '');

  // Headers — Authorization is injected by us (never from the template).
  const headers = { Authorization: `Bearer ${token}` };
  const headerTemplate = (actionDef.headers_template && typeof actionDef.headers_template === 'object') ? actionDef.headers_template : {};
  for (const [hk, hv] of Object.entries(headerTemplate)) {
    if (hk.toLowerCase() === 'authorization') continue; // never let the template override our injected auth
    headers[hk] = fillTemplateValue(hv, params, consumed);
  }

  // Body — every param not consumed by a placeholder, for body-bearing methods.
  let body;
  if (BODY_METHODS.has(method)) {
    const bodyObj = {};
    for (const [k, v] of Object.entries(params)) {
      if (!consumed.has(k)) bodyObj[k] = v;
    }
    if (Object.keys(bodyObj).length > 0) {
      body = bodyObj;
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
        headers['Content-Type'] = 'application/json';
      }
    }
  }

  return { method, url, headers, body };
}

// ---------------------------------------------------------------------------
//  Token lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Is this credential an OAuth token that can be refreshed? Everything is treated
 * as refreshable EXCEPT tokens explicitly marked api_key (static, long-lived).
 * Detection is intentionally conservative — an api_key must not be re-acquired
 * on a 401 (it will never change), while OAuth (including no-expiry tokens like
 * GitHub) must be refreshable via the reactive-401 path.
 */
export function isTokenRefreshable(cred) {
  if (!cred) return false;
  const marker = String(cred.auth_type || cred.token_type || '').toLowerCase();
  if (marker === 'api_key' || marker === 'apikey' || /api[_-]?key/.test(marker)) return false;
  return true;
}

function expiryMs(cred) {
  const raw = cred && cred.expires_at;
  if (raw == null) return null;
  if (typeof raw === 'number') {
    // Heuristic: values below ~year-2001-in-ms are epoch seconds.
    return raw < 1e12 ? raw * 1000 : raw;
  }
  const parsed = Date.parse(String(raw));
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Is the token at/near expiry? A token with no `expires_at` returns false — it
 * is never proactively refreshed and relies on the reactive-401 path instead
 * (this is the GitHub case).
 */
export function isTokenNearExpiry(cred, now = Date.now(), skewMs = DEFAULT_EXPIRY_SKEW_MS) {
  const exp = expiryMs(cred);
  if (exp == null) return false;
  return exp - now <= skewMs;
}

/**
 * Decide the execution path for a resolved connection from its cached
 * credential: `direct` iff a cached credential exists and its mode is `direct`,
 * otherwise `proxy` (server-side execute). This is the O2 mode split.
 */
export function chooseExecMode(credential) {
  return credential && credential.credential_mode === 'direct' ? 'direct' : 'proxy';
}

// ---------------------------------------------------------------------------
//  Audit logging (O6) — URL + params only, secrets redacted, short.
// ---------------------------------------------------------------------------

// Mirrors client.js's RPC logging surfaces: stdout gated by COCO_RPC_LOG,
// file append gated by COCO_RPC_LOG_FILE. Tagged [conn.direct] for grep.
function defaultAudit(line) {
  if (process.env.COCO_RPC_LOG !== '0') console.error(line);
  const filePath = process.env.COCO_RPC_LOG_FILE;
  if (filePath && filePath.length > 0) {
    // Lazy import to keep this a leaf module in the common (no-file) path.
    import('node:fs').then(({ appendFileSync, mkdirSync }) => {
      try {
        import('node:path').then(({ dirname }) => {
          try { mkdirSync(dirname(filePath), { recursive: true }); } catch {}
          try { appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`); } catch {}
        });
      } catch {}
    }).catch(() => {});
  }
}

function auditDirectCall(method, url, params, audit) {
  // Never log headers (Authorization lives there). Redact any secret-shaped
  // param values; keep it to one short line.
  const safeParams = JSON.stringify(redactSecrets(params || {}));
  audit(`[conn.direct] → ${method} ${url} params: ${safeParams}`);
}

// ---------------------------------------------------------------------------
//  HTTP send + orchestration
// ---------------------------------------------------------------------------

function headersToObject(h) {
  if (!h) return {};
  if (typeof h.entries === 'function') return Object.fromEntries(h.entries());
  if (typeof h.forEach === 'function') { const o = {}; h.forEach((v, k) => { o[k] = v; }); return o; }
  return { ...h };
}

/**
 * Send one assembled request and normalize the response into the server-parity
 * shape `{ status_code, headers, body }`. Raw passthrough — the provider body is
 * returned as parsed JSON when it parses, else as the raw string; it is never
 * transformed. A body over MAX_RESPONSE_BYTES is truncated and flagged.
 */
export async function sendDirect(assembled, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(assembled.url, {
    method: assembled.method,
    headers: assembled.headers,
    body: assembled.body !== undefined ? JSON.stringify(assembled.body) : undefined,
  });

  const text = await res.text();
  let body;
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    truncated = true;
    body = text.slice(0, MAX_RESPONSE_BYTES);
  } else {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  const out = { status_code: res.status, headers: headersToObject(res.headers), body };
  if (truncated) out.truncated = true;
  return out;
}

/**
 * Full direct-mode invoke: resolve → validate → (proactive OAuth refresh) →
 * assemble → send → (reactive-401 OAuth refresh once) → return.
 *
 * @param {object} args
 *   - orgId, connection ({id, applicationId, slug}), actionSlug, params
 *   - catalog: the action array (from the local catalog cache)
 *   - credential: the cached credential record (with access_token, expires_at,…)
 * @param {object} deps
 *   - fetchImpl        (default global fetch)
 *   - acquire(orgId, connectionId) → fresh credential record (re-acquire/refresh)
 *   - saveCache(connectionId, cred) → persist the refreshed credential
 *   - now()            (default Date.now) — for expiry math / tests
 *   - skewMs, audit, log, warn
 */
export async function invokeDirect(
  { orgId, connection, actionSlug, params = {}, catalog, credential },
  deps = {},
) {
  const {
    fetchImpl = fetch,
    acquire,
    saveCache = () => {},
    now = Date.now,
    skewMs = DEFAULT_EXPIRY_SKEW_MS,
    audit = defaultAudit,
    log = () => {},
    warn = () => {},
  } = deps;

  const actionDef = resolveActionDef(catalog, actionSlug);
  if (!actionDef) {
    throw Object.assign(new Error(`unknown action "${actionSlug}" for app (not in local catalog)`), { status: 404 });
  }
  const v = validateParams(params, actionDef.input_schema);
  if (!v.ok) {
    throw Object.assign(new Error(`params failed input_schema validation: ${v.errors.join('; ')}`), { status: 400 });
  }

  let cred = credential;
  const connId = connection.id;

  // Proactive refresh: OAuth tokens only, when at/near expiry. A refresh failure
  // is non-fatal here — proceed with the current token and let the 401 path try.
  if (acquire && isTokenRefreshable(cred) && isTokenNearExpiry(cred, now(), skewMs)) {
    try {
      const fresh = await acquire(orgId, connId);
      if (fresh && fresh.access_token) { saveCache(connId, fresh); cred = fresh; }
      log(`[conn.direct] refreshed near-expiry token conn=${connId}`);
    } catch (e) {
      warn(`[conn.direct] proactive refresh failed conn=${connId}: ${e.message}`);
    }
  }

  let assembled = assembleRequest(actionDef, params, cred && cred.access_token);
  auditDirectCall(assembled.method, assembled.url, params, audit);
  let result = await sendDirect(assembled, { fetchImpl });

  // Reactive refresh: a provider 401 on an OAuth token → refresh ONCE and retry.
  // api_key (non-refreshable) or a repeat 401 is surfaced as-is (no loop).
  if (result.status_code === 401 && acquire && isTokenRefreshable(cred)) {
    log(`[conn.direct] provider 401 conn=${connId}; reactive refresh + retry once`);
    const fresh = await acquire(orgId, connId); // if refresh itself throws, surface it
    if (fresh && fresh.access_token) {
      saveCache(connId, fresh);
      cred = fresh;
      assembled = assembleRequest(actionDef, params, cred.access_token);
      auditDirectCall(assembled.method, assembled.url, params, audit);
      result = await sendDirect(assembled, { fetchImpl });
    }
  }

  return result;
}
