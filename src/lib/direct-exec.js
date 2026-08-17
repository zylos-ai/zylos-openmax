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
 *   3. fills `{placeholder}` tokens in the url_template (path + query) from BOTH
 *      the action params AND the credential's `url_placeholders` (connection-owned
 *      NON-secret URL parts like a self-hosted connector's `base_url` — e.g.
 *      Jenkins, whose url_template starts with "{base_url}"), builds the JSON body
 *      from the *remaining* params, and injects the credential's auth generically
 *      (canonical `Authorization: <scheme> <token>` derived from token_type, or an
 *      optional auth_injection descriptor placing it in a custom header/query)
 *      plus any templated headers,
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
 * Token lifecycle (O4): two independent signals answer two questions.
 *   - `token_type` gates whether a token can be refreshed AT ALL: cws-connect
 *     stores `"api_key"` for api_key connections (no refresh flow) and
 *     `"bearer"` for OAuth. An api_key is NEVER refreshed — not proactively, not
 *     on a 401; a provider 401 is surfaced to the user.
 *   - `expires_at` gates whether a refreshable (OAuth) token should be refreshed
 *     PROACTIVELY before the call: present AND near/expired → refresh first.
 * A refreshable token WITHOUT `expires_at` (non-expiring OAuth like GitHub) is
 * not refreshed proactively but IS refreshed reactively — a provider 401
 * triggers a single refresh + retry; a second 401 is surfaced (no loop).
 * Refresh = re-acquire via cws-core (injected `acquire`) + re-save the cache.
 *
 * Pure-ish: `fetch`, `acquire`, and `saveCache` are injectable so this is unit
 * testable without network or disk. No import-time side effects.
 */

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

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

function hasVal(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Canonicalize a credential `token_type` into the HTTP Authorization scheme word.
 * Mirrors cws-connect's `canonicalAuthScheme` (connection_service.go) EXACTLY:
 *   - ""  / "bearer" (any case) / "api_key" (any case) → "Bearer".
 *     ("api_key" is a mode marker, NOT a real scheme; providers that carry a
 *     personal token in the Authorization header expect "Bearer", so normalize
 *     it rather than emit the invalid "Authorization: api_key".)
 *   - "basic" (any case) → "Basic" (the token value already holds
 *     base64(username:token), pre-baked at connection-creation time).
 *   - anything else → returned VERBATIM (e.g. "Token", "SSWS").
 */
export function canonicalAuthScheme(tokenType) {
  const t = tokenType == null ? '' : String(tokenType);
  if (t === '' || t.toLowerCase() === 'bearer' || t.toLowerCase() === 'api_key') return 'Bearer';
  if (t.toLowerCase() === 'basic') return 'Basic';
  return t;
}

function fillTemplateValue(str, params, urlPlaceholders, consumed) {
  return String(str).replace(/\{([^}]+)\}/g, (_, key) => {
    consumed.add(key);
    if (hasVal(params[key])) return String(params[key]);
    if (hasVal(urlPlaceholders[key])) return String(urlPlaceholders[key]);
    return '';
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
 *     "{id}" / "{base_url}" must never reach the wire).
 *   - QUERY placeholders are optional — a missing value drops that whole
 *     key=value pair.
 *   - HEADER placeholders (from headers_template) fill from both sources too.
 *   - Any param NOT consumed by a placeholder becomes a body field (body
 *     methods only). url_placeholders never contribute to the body.
 *
 * Placeholders resolve from TWO sources: the action `params` AND the
 * credential's `url_placeholders` (connection-owned, NON-secret URL parts like a
 * self-hosted connector's `base_url`, e.g. Jenkins whose url_template starts
 * with "{base_url}"). `params` win on a name clash. A value from `params` is
 * URL-encoded (it is data — a path/query value); a value from `url_placeholders`
 * is substituted VERBATIM (it is structural — a scheme/host/base-URL prefix that
 * must not be percent-encoded, or "https://host/x" would corrupt into
 * "https%3A%2F%2F…").
 *
 * Auth injection is GENERIC (mirrors cws-connect). Two paths:
 *   - `authInjection` descriptor present ({ location, name, value_template }) →
 *     expand value_template's literal "{token}" placeholder with the token, then
 *     place it: location==='header' sets headers[name] (verbatim, NOT
 *     URL-encoded); location==='query' appends name=encodeURIComponent(expanded)
 *     to the assembled URL's query string. The descriptor WINS over a
 *     headers_template key of the same name.
 *   - descriptor absent (today's 100% path) → set
 *     headers['Authorization'] = canonicalAuthScheme(tokenType) + ' ' + token.
 *     A headers_template 'authorization' key can NEVER override this.
 *
 * @param {object} actionDef
 * @param {object} [params]           action params (caller/LLM supplied)
 * @param {string} token             the injected token (EffectiveToken — already
 *                                   pre-baked for basic/token_param modes)
 * @param {object} [urlPlaceholders] connection-owned url placeholder values
 * @param {string} [tokenType]       credential token_type → Authorization scheme
 * @param {object} [authInjection]   optional generic injection descriptor
 *                                   { location:'header'|'query', name, value_template }
 */
export function assembleRequest(actionDef, params = {}, token, urlPlaceholders = {}, tokenType = '', authInjection = null) {
  if (!actionDef || typeof actionDef.url_template !== 'string' || !actionDef.url_template) {
    throw Object.assign(
      new Error('action has no url_template — local catalog is too old for direct execution (run conn.catalog {refresh:true})'),
      { status: 422 },
    );
  }
  const method = String(actionDef.method || 'GET').toUpperCase();
  const template = actionDef.url_template;
  const uph = (urlPlaceholders && typeof urlPlaceholders === 'object') ? urlPlaceholders : {};
  const consumed = new Set();

  const qIdx = template.indexOf('?');
  const pathPart = qIdx >= 0 ? template.slice(0, qIdx) : template;
  const queryPart = qIdx >= 0 ? template.slice(qIdx + 1) : '';

  // Path placeholders — required. Params first (URL-encoded data), then
  // connection-owned url_placeholders (verbatim structural prefix, e.g.
  // "{base_url}" → "https://jenkins.example.com").
  const path = pathPart.replace(/\{([^}]+)\}/g, (_, key) => {
    consumed.add(key);
    if (hasVal(params[key])) return encodeURIComponent(String(params[key]));
    if (hasVal(uph[key])) return String(uph[key]);
    // Neither source has it. A leading "{base_url}"-style placeholder is a
    // connection-owned URL part the credential should have carried — surface it
    // as a 422 (connection/credential too old) rather than a missing-param 400.
    if (pathPart.startsWith(`{${key}}`)) {
      throw Object.assign(
        new Error(`connection is missing URL placeholder "${key}" (e.g. base_url) — reconnect the connection or refresh the credential; url_placeholders did not provide it`),
        { status: 422 },
      );
    }
    throw Object.assign(new Error(`missing required path param "${key}" for action ${actionDef.toolkit}/${actionDef.action}`), { status: 400 });
  });

  // Query placeholders — optional (drop the pair when the value is absent).
  // Same two-source resolution; query values are always URL-encoded.
  const outPairs = [];
  for (const pair of queryPart.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const rawV = eq >= 0 ? pair.slice(eq + 1) : '';
    const m = /^\{([^}]+)\}$/.exec(rawV);
    if (m) {
      const key = m[1];
      consumed.add(key);
      const v = hasVal(params[key]) ? params[key] : uph[key];
      if (!hasVal(v)) continue; // optional query param omitted
      outPairs.push(`${k}=${encodeURIComponent(String(v))}`);
    } else {
      outPairs.push(pair); // static query segment
    }
  }
  let url = path + (outPairs.length ? `?${outPairs.join('&')}` : '');

  // Headers — templated headers first (Authorization is ours, never the
  // template's), then the generic auth injection is applied last so it wins.
  const headers = {};
  const headerTemplate = (actionDef.headers_template && typeof actionDef.headers_template === 'object') ? actionDef.headers_template : {};
  for (const [hk, hv] of Object.entries(headerTemplate)) {
    if (hk.toLowerCase() === 'authorization') continue; // never let the template override our injected auth
    headers[hk] = fillTemplateValue(hv, params, uph, consumed);
  }

  // Generic auth injection (mirrors cws-connect). A descriptor, when present,
  // fully controls placement and wins over any templated header of the same
  // name; otherwise we fall back to the canonical Authorization header — the
  // path taken by 100% of connections today.
  if (authInjection && typeof authInjection === 'object' && authInjection.location && authInjection.name) {
    const vt = typeof authInjection.value_template === 'string' ? authInjection.value_template : '{token}';
    const expanded = vt.replace(/\{token\}/g, token == null ? '' : String(token));
    if (authInjection.location === 'query') {
      // Query value IS URL-encoded (it rides in the URL); header value is verbatim.
      url += `${url.includes('?') ? '&' : '?'}${authInjection.name}=${encodeURIComponent(expanded)}`;
    } else {
      // Drop any templated header of the SAME NAME case-insensitively before
      // setting ours — otherwise a template `x-api-key` and an injected
      // `X-API-Key` both survive as distinct object keys and Node/fetch merges
      // them into one comma-joined value, so the descriptor would not truly win.
      const lower = authInjection.name.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === lower) delete headers[k];
      }
      headers[authInjection.name] = expanded;
    }
  } else {
    headers.Authorization = `${canonicalAuthScheme(tokenType)} ${token}`;
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
 * Can this token be refreshed at all? Gated solely by `token_type`: cws-connect
 * stores `"api_key"` for api_key connections (which have NO refresh flow) and
 * `"bearer"` for OAuth. Everything that is not explicitly `"api_key"` is treated
 * as refreshable OAuth (a missing token_type defaults to refreshable — the
 * GitHub-style no-expiry OAuth case). This is what separates a non-refreshable
 * api_key from a no-expiry OAuth token: `expires_at` alone cannot, since both
 * lack it.
 */
export function isTokenRefreshable(cred) {
  if (!cred) return false;
  // Normalized exact match: api_key is the fixed value "api_key", while OAuth's
  // token_type varies in case across providers ("Bearer"/"bearer"). Only an
  // exact (trimmed, lowercased) "api_key" is non-refreshable; every other value
  // — including any casing of bearer and anything unexpected — is OAuth.
  return String(cred.token_type || '').trim().toLowerCase() !== 'api_key';
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
 * Is the token at/near expiry? `expires_at` presence gates PROACTIVE refresh: a
 * token with no `expires_at` returns false — it is never proactively refreshed
 * (a refreshable one still relies on the reactive-401 backstop; this is the
 * GitHub-style no-expiry OAuth case).
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

/**
 * Resolve the credential + execution mode for an invoke, re-acquiring on a cache
 * miss so a direct connection with NO local credential file is not wrongly
 * downgraded to proxy.
 *
 * A direct connection may have no cache file — authorized while offline, runtime/
 * wiped/reinstalled, or conn.clear_cache was run. Since cws-connect now rejects a
 * direct connection on the proxy/execute path (ErrDirectNotProxyable/422), on a
 * miss we `acquire` once: `acquire` works for both modes and returns
 * `credential_mode`, so a direct result is saved locally and used, while a proxy
 * result leaves the credential null (→ proxy path, which caches nothing). An
 * acquire FAILURE propagates — we never silently downgrade a direct call.
 *
 * @returns {Promise<{credential: object|null, mode: 'direct'|'proxy'}>}
 */
export async function resolveCredential({ orgId, connectionId, cached }, { acquire, saveCache = () => {} } = {}) {
  let credential = cached || null;
  if (!credential && acquire) {
    const acquired = await acquire(orgId, connectionId); // throws → surfaced by caller
    if (acquired && acquired.credential_mode === 'direct') {
      saveCache(connectionId, acquired);
      credential = acquired;
    }
    // proxy / unknown → leave credential null so chooseExecMode routes to proxy.
  }
  return { credential, mode: chooseExecMode(credential) };
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

function auditDirectCall(method, urlTemplate, params, audit) {
  // Log the UN-expanded url_template, NOT the concrete URL: a query placeholder
  // like "?api_key={api_key}" would otherwise expand to the plaintext secret in
  // the log line. The template keeps placeholders literal ("{api_key}"), so no
  // secret can ever reach the log via the URL. Params are separately redacted
  // (redactSecrets masks secret-shaped keys), and headers (where Authorization
  // lives) are never logged. One short line.
  const safeParams = JSON.stringify(redactSecrets(params || {}));
  audit(`[conn.direct] → ${method} ${urlTemplate} params: ${safeParams}`);
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
 * Read a fetch Response body with a STREAMING byte cap, so an oversized provider
 * response never fully lands in memory. Reads `res.body` incrementally and
 * accumulates up to MAX_RESPONSE_BYTES; the moment the running total exceeds the
 * cap it cancels the stream and THROWS (over-cap is an ERROR, not a silent
 * truncation — a truncated body would be a corrupt/misleading passthrough).
 *
 * Falls back to `res.text()` only when the response exposes no readable stream
 * (e.g. a minimal test double); that path still enforces the cap, but by then
 * the body is already buffered, so it is a compatibility fallback, not the
 * memory-safety guarantee. Production `fetch` always provides `res.body`.
 */
async function readCappedText(res) {
  const reader = res.body && typeof res.body.getReader === 'function' ? res.body.getReader() : null;
  if (!reader) {
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
      throw Object.assign(
        new Error(`provider response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`),
        { status: 502 },
      );
    }
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length ?? value.byteLength ?? 0;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* best-effort */ }
        throw Object.assign(
          new Error(`provider response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`),
          { status: 502 },
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released/cancelled */ }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Send one assembled request and normalize the response into the server-parity
 * shape `{ status_code, headers, body }`. Raw passthrough — the provider body is
 * returned as parsed JSON when it parses, else as the raw string; it is never
 * transformed. The body is read with a streaming cap (see readCappedText): a
 * response over MAX_RESPONSE_BYTES throws (status 502) rather than being
 * buffered whole or silently truncated.
 */
export async function sendDirect(assembled, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(assembled.url, {
    method: assembled.method,
    headers: assembled.headers,
    body: assembled.body !== undefined ? JSON.stringify(assembled.body) : undefined,
  });

  const text = await readCappedText(res);
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status_code: res.status, headers: headersToObject(res.headers), body };
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

  // Proactive refresh: refreshable (OAuth) tokens only, and only when they carry
  // an `expires_at` that is at/near expiry. api_key (token_type "api_key") is
  // never touched. A refresh failure here is non-fatal — proceed with the current
  // token and let the reactive-401 backstop try.
  if (acquire && isTokenRefreshable(cred) && isTokenNearExpiry(cred, now(), skewMs)) {
    try {
      const fresh = await acquire(orgId, connId);
      if (fresh && fresh.access_token) { saveCache(connId, fresh); cred = fresh; }
      log(`[conn.direct] refreshed near-expiry token conn=${connId}`);
    } catch (e) {
      warn(`[conn.direct] proactive refresh failed conn=${connId}: ${e.message}`);
    }
  }

  let assembled = assembleRequest(
    actionDef,
    params,
    cred && cred.access_token,
    cred && cred.url_placeholders,
    cred && cred.token_type,
    cred && cred.auth_injection,
  );
  auditDirectCall(assembled.method, actionDef.url_template, params, audit);
  let result = await sendDirect(assembled, { fetchImpl });

  // Reactive refresh backstop (refreshable/OAuth only): a provider 401 → refresh
  // ONCE and retry. This covers no-expiry OAuth (GitHub) and any token whose
  // proactive refresh was skipped/stale. An api_key is NOT refreshed here — its
  // 401 is surfaced as-is. A second 401 is likewise surfaced (no loop).
  if (result.status_code === 401 && acquire && isTokenRefreshable(cred)) {
    log(`[conn.direct] provider 401 conn=${connId}; reactive refresh + retry once`);
    const fresh = await acquire(orgId, connId); // if refresh itself throws, surface it
    if (fresh && fresh.access_token) {
      saveCache(connId, fresh);
      cred = fresh;
      assembled = assembleRequest(
        actionDef,
        params,
        cred.access_token,
        cred.url_placeholders,
        cred.token_type,
        cred.auth_injection,
      );
      auditDirectCall(assembled.method, actionDef.url_template, params, audit);
      result = await sendDirect(assembled, { fetchImpl });
    }
  }

  return result;
}

// ===========================================================================
//  conn.request — raw / fully-custom direct request (Task #12)
//
//  A generalization of the direct-mode executor above. Where invokeDirect drives
//  the URL from a catalog url_template + schema-checked params, conn.request lets
//  the caller supply the whole request (domain + path + method + headers + query
//  + body) and the CLI attaches the connection's LOCAL direct-mode token and
//  calls the provider directly over HTTPS.
//
//  Because the data plane no longer passes through cws-connect/cws-core, EVERY
//  boundary is enforced here on the agent side, and each boundary is STRUCTURAL —
//  it constrains the credential's REAL destination (host + port + resolved IP),
//  not just a hostname string:
//
//   1. ORIGIN ALLOWLIST (the core gate). The allowed set is a set of normalized
//      origins (scheme=https, host, port) derived from the connection's
//      action-catalog url_templates (port defaults to 443 when a template omits
//      it). A request is allowed only when its (host, port) EXACTLY matches an
//      allowed origin — an off-catalog port (e.g. api.example.com:8443 when the
//      catalog only warrants :443) is rejected. Exact host, no *.domain wildcard.
//   2. CLI-OWNED ROUTING. Host and other routing-override headers are the CLI's,
//      derived from the validated target; a caller-supplied Host / :authority is
//      REJECTED (never forwarded), so a header cannot redirect the token to a
//      different vhost/tenant than the origin the allowlist authorized.
//   3. DNS RESOLVE-VALIDATE-AND-PIN. Before connecting, the target host is
//      resolved to ALL its addresses; every address must be a public /
//      global-unicast IP (private / CGNAT / loopback / link-local / ULA /
//      metadata are rejected). One validated address is then PINNED and the
//      actual TLS connection is made to that pinned IP (SNI + Host = the real
//      hostname), so a DNS-rebind between validation and connect cannot swing the
//      token onto an internal address — there is no second, unvalidated lookup.
//   4. FRESHNESS FAIL-CLOSED. The allowlist is only as trustworthy as the catalog
//      it is derived from; a missing / stale catalog (or a record with no
//      fetchedAt) refuses the request and asks for `conn.catalog {refresh:true}`
//      rather than authorizing off a stale host set.
//
//  On ANY gate failure the token is NEVER attached to a header and NEVER sent.
//  Additional boundaries: HTTPS-only, Authorization is CLI-owned (a caller header
//  can never override it), no cross-domain redirect follow, and no token/secret
//  in logs (audit is method + host + redacted pathname only).
// ===========================================================================

// Raw-egress catalog freshness window. The allowlist is derived from the local
// action catalog, so a stale catalog means a host removed upstream stays
// authorized. conn.request fails CLOSED beyond this window (and on any record
// lacking a numeric fetchedAt) rather than authorizing off a stale host set.
export const RAW_CATALOG_FRESHNESS_MS = 24 * 60 * 60 * 1000;

// Maximum tolerated clock skew for freshness. A fetchedAt in the FUTURE beyond
// this small bound is not "fresh forever" — it is a broken/forged timestamp and
// is refused (fail-closed). Freshness therefore requires a NON-NEGATIVE age
// (within this skew), not merely age ≤ window.
export const CATALOG_CLOCK_SKEW_MS = 5 * 60 * 1000;

// Methods conn.request accepts (a superset of BODY_METHODS; the read verbs carry
// no body).
const RAW_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/**
 * Extract the static HOST from an action url_template. Returns the lowercased
 * hostname (userinfo + port + trailing dot stripped) or null when the template
 * is not an absolute https URL, or its authority is itself a {placeholder} (a
 * self-hosted "{base_url}/..." template — its host is connection-owned and not
 * catalog-derivable, so it contributes NO allowed host). A non-https template
 * never widens the allowlist either (conn.request is HTTPS-only).
 */
export function hostFromUrlTemplate(urlTemplate) {
  if (typeof urlTemplate !== 'string' || !urlTemplate) return null;
  if (!/^https:\/\//i.test(urlTemplate)) return null;
  const m = /^https:\/\/([^/?#]+)/i.exec(urlTemplate);
  if (!m) return null;
  let authority = m[1];
  if (authority.includes('{') || authority.includes('}')) return null; // placeholder host
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1); // strip userinfo
  const host = authority.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
  return host || null;
}

/**
 * Derive the allowed-host set for a connection = the UNION of the hosts extracted
 * from every action's url_template in the local (already-warmed) action catalog.
 * Exact hosts only — NO wildcards. New connectors/actions extend the set
 * automatically; nothing about the allowlist is hardcoded into openmax.
 */
export function allowedHostsFromCatalog(catalog) {
  const set = new Set();
  for (const a of Array.isArray(catalog) ? catalog : []) {
    const h = hostFromUrlTemplate(a && a.url_template);
    if (h) set.add(h);
  }
  return set;
}

/**
 * Extract the normalized ORIGIN (host + port) from an action url_template. Like
 * hostFromUrlTemplate but PRESERVES the port so the allowlist can constrain the
 * credential's real destination and not just its hostname. HTTPS is implicit
 * (conn.request is HTTPS-only), so the port DEFAULTS TO 443 when the template
 * omits it. Returns { host, port } or null (non-https / placeholder authority).
 */
export function originFromUrlTemplate(urlTemplate) {
  if (typeof urlTemplate !== 'string' || !urlTemplate) return null;
  if (!/^https:\/\//i.test(urlTemplate)) return null;
  const m = /^https:\/\/([^/?#]+)/i.exec(urlTemplate);
  if (!m) return null;
  let authority = m[1];
  if (authority.includes('{') || authority.includes('}')) return null; // placeholder authority
  const at = authority.lastIndexOf('@');
  if (at >= 0) authority = authority.slice(at + 1); // strip userinfo
  const portMatch = /:(\d+)$/.exec(authority);
  const port = portMatch ? Number(portMatch[1]) : 443;
  const host = authority.replace(/:\d+$/, '').toLowerCase().replace(/\.$/, '');
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Stable key for an origin: "host:port" (port always explicit, 443 default). */
export function originKey(host, port) {
  return `${String(host).toLowerCase().replace(/\.$/, '')}:${port}`;
}

/**
 * Derive the allowed-ORIGIN set for a connection = the UNION of (host, port)
 * origins from every action's url_template in the local catalog, each as an
 * "host:port" key (port defaulting to 443). This is the structural policy the
 * conn.request gate enforces: a requested (host, port) MUST match one of these
 * exactly, so a caller cannot keep the allowed host but swing the port to an
 * unintended service. Placeholder / non-https templates contribute nothing.
 */
export function allowedOriginsFromCatalog(catalog) {
  const set = new Set();
  for (const a of Array.isArray(catalog) ? catalog : []) {
    const o = originFromUrlTemplate(a && a.url_template);
    if (o) set.add(originKey(o.host, o.port));
  }
  return set;
}

/**
 * Parse + validate a caller-supplied `domain`: it MUST be a bare host (optionally
 * host:port) — never a scheme, path, query, or userinfo. Returns
 * { hostname, port, authority } (hostname lowercased; port is the explicit port
 * or 443 by default — HTTPS is implicit; authority = host[:port] as given) or
 * null. Rejecting anything with "://", "/", "@", "?", "#", or whitespace stops a
 * caller from smuggling "evil.com/@good" / "good.com/../evil" style values past
 * the allowlist gate. The port is surfaced so the origin gate can enforce
 * (host, port) — a caller cannot keep an allowed host but swing to an off-catalog
 * port to reach a different service with the credential.
 */
export function parseRequestTarget(domain) {
  if (typeof domain !== 'string') return null;
  const d = domain.trim();
  if (!d || d.includes('://') || /[\s/\\@?#]/.test(d)) return null;
  let u;
  try { u = new URL(`https://${d}`); } catch { return null; }
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) return null;
  const hostname = (u.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!hostname) return null;
  const port = u.port ? Number(u.port) : 443;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname, port, authority: u.port ? `${hostname}:${u.port}` : hostname };
}

// ---------------------------------------------------------------------------
//  IP parsing + CIDR classification (SSRF guard)
//
//  Every IP verdict below works on the PARSED, canonical bytes of the address —
//  never on a string prefix or a single spelling. This defeats the encoding
//  bypasses a prefix match misses: link-local written as fe90::/fea0::/febf::
//  (all inside fe80::/10), a v4-mapped private address written in hex
//  (::ffff:a00:1) rather than dotted (::ffff:10.0.0.1), an expanded loopback
//  (0:0:0:0:0:0:0:1), and v4-compatible ::10.0.0.1 forms. We parse to bytes with
//  net.isIP as the validity gate, then classify by full CIDR ranges.
// ---------------------------------------------------------------------------

/** Parse a dotted-quad IPv4 string to its 4 octets, or null when not valid v4. */
function parseIPv4(str) {
  if (net.isIPv4(str) !== true) return null;
  const parts = String(str).split('.').map((n) => Number(n));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts;
}

/** Classify 4 IPv4 octets. true ⇒ disallowed (non-public / internal). */
function ipv4BytesDisallowed([a, b]) {
  if (a === 0) return true;                          // 0.0.0.0/8 "this host"
  if (a === 127) return true;                        // loopback 127/8
  if (a === 10) return true;                         // private 10/8
  if (a === 172 && b >= 16 && b <= 31) return true;  // private 172.16/12
  if (a === 192 && b === 168) return true;           // private 192.168/16
  if (a === 169 && b === 254) return true;           // link-local 169.254/16 (+ metadata .169.254)
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a >= 224) return true;                         // multicast / reserved 224+/3
  return false;
}

/**
 * Parse an IPv6 string to its 16 canonical bytes, or null when not valid v6.
 * Uses net.isIPv6 as the validity gate, then expands "::" and any embedded IPv4
 * tail (e.g. "::ffff:1.2.3.4") into the full byte array. Zone id / brackets must
 * be stripped by the caller.
 */
function parseIPv6(str) {
  if (net.isIPv6(str) !== true) return null;
  let s = String(str);
  // Fold a trailing embedded IPv4 (v4-mapped / v4-compatible) into two hextets.
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    const v4 = parseIPv4(s.slice(idx + 1));
    if (!v4) return null;
    const hi = ((v4[0] << 8) | v4[1]).toString(16);
    const lo = ((v4[2] << 8) | v4[3]).toString(16);
    s = `${s.slice(0, idx + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups;
  if (halves.length === 2) {
    const missing = 8 - (head.length + tail.length);
    if (missing < 0) return null;
    groups = [...head, ...Array(missing).fill('0'), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 0xff, n & 0xff);
  }
  return bytes;
}

/** Classify 16 IPv6 bytes. true ⇒ disallowed (non-global-unicast / internal). */
function ipv6BytesDisallowed(b) {
  const first10Zero = b.slice(0, 10).every((x) => x === 0);
  // v4-mapped ::ffff:x.x.x.x — classify by the embedded v4 (dotted OR hex form).
  if (first10Zero && b[10] === 0xff && b[11] === 0xff) {
    return ipv4BytesDisallowed([b[12], b[13], b[14], b[15]]);
  }
  if (b.every((x) => x === 0)) return true;                        // unspecified ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return true; // loopback ::1 (any spelling)
  // v4-compatible ::a.b.c.d (deprecated) — classify by the embedded v4 too, so
  // ::10.0.0.1 / ::127.0.0.1 style forms cannot slip a private v4 through.
  if (b.slice(0, 12).every((x) => x === 0)) {
    return ipv4BytesDisallowed([b[12], b[13], b[14], b[15]]);
  }
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;        // link-local fe80::/10 (fe80–febf)
  if ((b[0] & 0xfe) === 0xfc) return true;                         // ULA fc00::/7
  if (b[0] === 0xff) return true;                                  // multicast ff00::/8
  return false;                                                    // global unicast
}

/**
 * Classify an IP LITERAL string on its parsed bytes. Returns true (disallowed),
 * false (public / global-unicast), or null when the string is not an IP literal
 * at all (so callers can decide how to treat a non-IP hostname).
 */
function classifyIpLiteral(str) {
  const a = String(str).toLowerCase().replace(/^\[/, '').replace(/\]$/, '').replace(/%.*$/, '');
  const v4 = parseIPv4(a);
  if (v4) return ipv4BytesDisallowed(v4);
  const v6 = parseIPv6(a);
  if (v6) return ipv6BytesDisallowed(v6);
  return null;
}

/** Back-compat helper: is a dotted-quad IPv4 string disallowed? Invalid → true. */
function isDisallowedIPv4(ip) {
  const parts = parseIPv4(String(ip));
  if (!parts) return true;
  return ipv4BytesDisallowed(parts);
}

/**
 * SSRF guard on a host STRING: reject loopback / link-local / private / CGNAT /
 * cloud-metadata targets so a real credential can never be coaxed onto an
 * internal address. Defense-in-depth BEHIND the allowlist (catalog hosts are
 * public providers). A few hostname SUFFIXES (localhost / .localhost / .internal
 * / .local) are blocked by name; a literal IP (v4 or v6, any encoding) is
 * classified structurally on its parsed bytes. An ordinary DNS NAME is left to
 * resolveAndPin, which validates every RESOLVED address.
 */
export function isDisallowedHost(hostname) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local')) return true;
  const verdict = classifyIpLiteral(h);
  if (verdict === null) return false; // a non-IP hostname → resolved & validated in resolveAndPin
  return verdict;
}

/**
 * Is a RESOLVED IP address disallowed? Applied to every address a hostname
 * resolves to (see resolveAndPin). Unlike isDisallowedHost (which reasons about a
 * host STRING and lets an unknown hostname through to DNS), this reasons about a
 * concrete literal IP and FAILS CLOSED: anything that is not a recognizable
 * public/global-unicast literal is rejected. Classification is on the PARSED
 * bytes (not a string prefix), so every encoding of loopback / private / CGNAT /
 * link-local (fe80::/10 incl. fe90/fea0/febf) / ULA / multicast / metadata /
 * v4-mapped-private (dotted OR hex) is blocked, for both v4 and v6.
 */
export function isDisallowedAddress(address) {
  if (!address) return true;
  const verdict = classifyIpLiteral(address);
  if (verdict === null) return true; // not a recognizable IP literal → fail closed
  return verdict;
}

/**
 * The default DNS resolver used by resolveAndPin: resolve a hostname to ALL of
 * its A/AAAA addresses. `verbatim:true` keeps the resolver order (we validate ALL
 * addresses regardless, so order only affects which public IP we pin). Injectable
 * so unit tests never touch real DNS. Returns [{ address, family }].
 */
async function defaultResolve(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

/**
 * Resolve `hostname` to all its addresses, require EVERY address to be a public /
 * global-unicast IP, then PIN one validated address for the actual connection.
 * This is the structural DNS-rebinding defense: the same resolution that is
 * validated is the one connected to (the pinned IP is handed to the transport,
 * which does NOT resolve again) — so a rebind that flips the record to an internal
 * address between validation and connect has no unvalidated second lookup to
 * exploit. Throws (403) with the token never attached if ANY address is
 * disallowed, or (502) if resolution yields nothing.
 *
 * @returns {Promise<{ pinnedIp: string, family: number, addresses: string[] }>}
 */
export async function resolveAndPin(hostname, resolve = defaultResolve) {
  let records;
  try {
    records = await resolve(hostname);
  } catch (e) {
    throw Object.assign(new Error(`DNS resolution failed for "${hostname}": ${e.message}`), { status: 502 });
  }
  const list = (Array.isArray(records) ? records : [records])
    .map((r) => (typeof r === 'string' ? { address: r, family: r.includes(':') ? 6 : 4 } : r))
    .filter((r) => r && r.address);
  if (list.length === 0) {
    throw Object.assign(new Error(`DNS returned no addresses for "${hostname}"`), { status: 502 });
  }
  for (const r of list) {
    if (isDisallowedAddress(r.address)) {
      throw Object.assign(
        new Error(`domain "${hostname}" resolves to a blocked internal / private address (${r.address}) — refusing; the credential is never attached or sent`),
        { status: 403 },
      );
    }
  }
  const pinned = list[0];
  return {
    pinnedIp: pinned.address,
    family: pinned.family || (pinned.address.includes(':') ? 6 : 4),
    addresses: list.map((r) => r.address),
  };
}

function buildRawQuery(query) {
  if (query == null) return '';
  if (typeof query === 'string') return query.replace(/^\?/, '');
  if (typeof query !== 'object' || Array.isArray(query)) return '';
  const parts = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    const ek = encodeURIComponent(k);
    if (Array.isArray(v)) { for (const item of v) parts.push(`${ek}=${encodeURIComponent(String(item))}`); }
    else parts.push(`${ek}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

/**
 * Assemble a fully-custom HTTPS request for conn.request from an authority
 * (host[:port]) + path + query + method + headers + body, plus the injected
 * token. Mirrors assembleRequest's auth-injection contract but with a
 * caller-supplied URL instead of a catalog url_template. Returns
 * { method, url, headers, body } where `body` is ALREADY SERIALIZED (a string or
 * undefined) — sendRawDirect passes it verbatim (never re-encodes).
 *
 * SECURITY:
 *   - HTTPS only — the URL is always built as `https://<authority>...`.
 *   - Authorization is CLI-OWNED: a caller `authorization` header (any case) is
 *     dropped, and the CLI auth is applied LAST so it wins over any same-named
 *     header. Default is `Authorization: <canonicalAuthScheme(tokenType)> <token>`;
 *     an optional auth_injection descriptor can place it in a custom header/query
 *     (parity with assembleRequest / cws-connect).
 */
export function assembleRawRequest(
  { authority, path = '/', method = 'GET', headers = {}, query, body } = {},
  token,
  tokenType = '',
  authInjection = null,
) {
  const m = String(method || 'GET').toUpperCase();
  if (!RAW_METHODS.has(m)) {
    throw Object.assign(new Error(`unsupported HTTP method "${method}"`), { status: 400 });
  }
  if (!authority) {
    throw Object.assign(new Error('assembleRawRequest: authority (host) is required'), { status: 400 });
  }
  let p = path == null ? '/' : String(path);
  if (!p.startsWith('/')) p = `/${p}`;
  // The query string and fragment are CLI-assembled from the dedicated `query`
  // field; a "?"/"#" embedded in `path` is rejected so a caller-supplied secret
  // (e.g. "/v1/items?api_key=SECRET") can never ride in via the path and reach a
  // log or the wire un-owned. Query params MUST go through `query`.
  //
  // CANONICALIZATION-AWARE: a percent-encoded "%3F"(?) / "%23"(#) decodes to the
  // same delimiter and would otherwise slip a query/secret ("/v1/%3Fapi_key%3D…")
  // past the literal check and into the audit line verbatim. Decode ONCE and
  // reject the encoded forms exactly like their literal counterparts.
  let decodedPath = p;
  try { decodedPath = decodeURIComponent(p); } catch { /* malformed %-escape → keep raw */ }
  if (p.includes('?') || p.includes('#') || decodedPath.includes('?') || decodedPath.includes('#')) {
    throw Object.assign(
      new Error('path must not contain "?" or "#" (encoded "%3F"/"%23" included) — pass query parameters via the dedicated `query` field'),
      { status: 400 },
    );
  }

  const qs = buildRawQuery(query);
  let url = `https://${authority}${p}`;
  if (qs) url += `?${qs}`;

  // Caller headers first — but Authorization is CLI-owned and stripped here so it
  // can NEVER be overridden by a caller-supplied header, and routing-override
  // headers (Host / :authority) are dropped: the CLI owns Host, derived from the
  // validated authority, so a caller header cannot steer the token to a different
  // vhost than the origin the allowlist authorized.
  const outHeaders = {};
  const src = (headers && typeof headers === 'object' && !Array.isArray(headers)) ? headers : {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof k !== 'string') continue;
    const lk = k.toLowerCase();
    if (lk === 'authorization') continue;                 // non-overridable
    if (lk === 'host' || lk === ':authority') continue;   // CLI-owned routing
    if (v === undefined || v === null) continue;
    outHeaders[k] = String(v);
  }

  // CLI-owned auth injected LAST so it wins over any same-named caller header.
  if (authInjection && typeof authInjection === 'object' && authInjection.location && authInjection.name) {
    const vt = typeof authInjection.value_template === 'string' ? authInjection.value_template : '{token}';
    const expanded = vt.replace(/\{token\}/g, token == null ? '' : String(token));
    if (authInjection.location === 'query') {
      url += `${url.includes('?') ? '&' : '?'}${authInjection.name}=${encodeURIComponent(expanded)}`;
    } else {
      const lower = authInjection.name.toLowerCase();
      for (const k of Object.keys(outHeaders)) { if (k.toLowerCase() === lower) delete outHeaders[k]; }
      outHeaders[authInjection.name] = expanded;
    }
  } else {
    outHeaders.Authorization = `${canonicalAuthScheme(tokenType)} ${token}`;
  }

  // Body — only for body-bearing methods. Object → JSON (+ Content-Type unless the
  // caller already set one); string → sent verbatim (caller owns its content type).
  let outBody;
  if (BODY_METHODS.has(m) && body !== undefined && body !== null) {
    if (typeof body === 'string') {
      outBody = body;
    } else {
      outBody = JSON.stringify(body);
      if (!Object.keys(outHeaders).some((hk) => hk.toLowerCase() === 'content-type')) {
        outHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  return { method: m, url, headers: outHeaders, body: outBody };
}

/**
 * Read a Node IncomingMessage (node:https response) with the same STREAMING byte
 * cap as readCappedText — an over-cap body throws (502) instead of buffering
 * whole. Used by the pinned-HTTPS transport (which yields a Node stream, not a
 * fetch Response).
 */
async function readCappedStream(res) {
  const chunks = [];
  let total = 0;
  for await (const chunk of res) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_RESPONSE_BYTES) {
      res.destroy();
      throw Object.assign(new Error(`provider response exceeds the ${MAX_RESPONSE_BYTES}-byte cap`), { status: 502 });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The production RAW transport: send one assembled request over node:https to a
 * PINNED IP. The socket connects to `pin.pinnedIp` (via a custom `lookup` that
 * ignores any fresh DNS answer), while TLS SNI (`servername`) and the `Host`
 * header are the real hostname — so the certificate is validated against the real
 * host AND a DNS-rebind cannot move the connection off the validated address.
 * node:https does NOT auto-follow redirects, so a 3xx is returned as-is (parity
 * with the former `redirect:'manual'`), never forwarding the Authorization header.
 */
/**
 * Build the custom node:https `lookup` that ALWAYS returns the pinned IP and
 * never performs a real DNS query. It MUST handle BOTH callback shapes Node uses:
 *   - happyeyeballs / autoSelectFamily (default true on Node ≥ v20) calls it with
 *     `{ all: true }` and expects an ARRAY `[{ address, family }]`;
 *   - the legacy scalar path expects `(err, address, family)`.
 * Returning only the scalar shape breaks the array-expecting path with
 * `ERR_INVALID_IP_ADDRESS: Invalid IP address: undefined` — the real production
 * failure that made the pinned transport unusable. Honour whichever shape the
 * caller asked for so the pinned IP is used on every Node version.
 */
export function pinnedLookup(pin) {
  const family = pin && pin.family ? pin.family : (pin && pin.pinnedIp && pin.pinnedIp.includes(':') ? 6 : 4);
  return (_hostname, opts, cb) => {
    // Node also permits lookup(hostname, cb) — 2-arg — where `opts` is the cb.
    const callback = typeof opts === 'function' ? opts : cb;
    const options = typeof opts === 'function' ? {} : (opts || {});
    if (options.all) callback(null, [{ address: pin.pinnedIp, family }]);
    else callback(null, pin.pinnedIp, family);
  };
}

export function sendPinnedHttps(assembled, pin, tlsOptions = {}) {
  if (!pin || !pin.pinnedIp) {
    return Promise.reject(Object.assign(new Error('sendPinnedHttps: a validated pinned IP is required'), { status: 500 }));
  }
  const url = new URL(assembled.url);
  const port = url.port ? Number(url.port) : 443;
  const headers = { ...assembled.headers, Host: url.host }; // CLI-owned Host
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: assembled.method,
        headers,
        servername: url.hostname, // SNI = real host (cert validated against it)
        lookup: pinnedLookup(pin),
        // TLS trust anchors are default (rejectUnauthorized:true) in production;
        // tests may inject a self-signed loopback CA here without weakening the
        // real path. Only whitelisted TLS knobs are threaded through.
        ...(tlsOptions.ca !== undefined ? { ca: tlsOptions.ca } : {}),
        ...(tlsOptions.rejectUnauthorized !== undefined ? { rejectUnauthorized: tlsOptions.rejectUnauthorized } : {}),
      },
      (res) => {
        readCappedStream(res)
          .then((text) => {
            let body;
            try { body = JSON.parse(text); } catch { body = text; }
            resolve({ status_code: res.statusCode, headers: { ...res.headers }, body });
          })
          .catch(reject);
      },
    );
    req.on('error', reject);
    if (assembled.body !== undefined && assembled.body !== null) req.write(assembled.body);
    req.end();
  });
}

/**
 * Send one assembled RAW request. Two transports:
 *   - default (production): pinned node:https (see sendPinnedHttps) — connects to
 *     the pre-validated PINNED IP, defeating DNS-rebinding. Requires `pin`.
 *   - injected `fetchImpl` (unit tests): the fetch path, with `redirect:'manual'`
 *     so a cross-domain 3xx is never auto-followed (which would forward the
 *     Authorization header off-allowlist). No real socket/DNS is touched.
 * `body` is already serialized so it is passed verbatim (never re-encoded). Same
 * server-parity shape as sendDirect: `{ status_code, headers, body }`.
 */
export async function sendRawDirect(assembled, { fetchImpl, pin, tlsOptions } = {}) {
  if (fetchImpl) {
    const res = await fetchImpl(assembled.url, {
      method: assembled.method,
      headers: assembled.headers,
      body: assembled.body !== undefined ? assembled.body : undefined,
      redirect: 'manual',
    });
    const text = await readCappedText(res);
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status_code: res.status, headers: headersToObject(res.headers), body };
  }
  return sendPinnedHttps(assembled, pin, tlsOptions || {});
}

// Audit a raw call: method + host + REDACTED PATHNAME only. Headers (where
// Authorization lives), the query string, the fragment, and the body are NEVER
// logged — any of them could carry a caller-supplied secret. The pathname is
// defensively DECODED FIRST (canonicalization-aware) and then stripped of any
// "?"/"#" tail — so an encoded "%3F…"(?) query smuggled into `path` cannot reach
// the audit line verbatim (assembleRawRequest already rejects both literal and
// encoded forms, so this is belt-and-suspenders). One short line, tagged for grep.
function auditRawCall(method, authority, normPath, audit) {
  let decoded = String(normPath == null ? '/' : normPath);
  try { decoded = decodeURIComponent(decoded); } catch { /* malformed %-escape → use raw */ }
  const pathnameOnly = decoded.split(/[?#]/)[0] || '/';
  audit(`[conn.request] → ${method} https://${authority}${pathnameOnly}`);
}

/**
 * Reject caller-supplied routing-override headers (Host / :authority). The CLI
 * owns Host — it is derived from the validated target — so a caller header could
 * only try to steer the credential to a different vhost/tenant than the origin
 * the allowlist authorized. We REJECT (rather than silently drop) so the failure
 * is visible; assembleRawRequest additionally drops them as belt-and-suspenders.
 */
function assertNoRoutingHeaders(headers) {
  const src = (headers && typeof headers === 'object' && !Array.isArray(headers)) ? headers : {};
  for (const k of Object.keys(src)) {
    const lk = String(k).toLowerCase();
    if (lk === 'host' || lk === ':authority') {
      throw Object.assign(
        new Error(`caller-supplied "${k}" header is not allowed — the CLI owns Host (derived from the validated target); remove it`),
        { status: 400 },
      );
    }
  }
}

/**
 * conn.request orchestration. STRUCTURAL boundaries, each enforced BEFORE the
 * credential token is ever read/attached (so on ANY gate failure the token is
 * NEVER attached to a header and NEVER sent):
 *   1. freshness fail-closed — a missing/stale catalog refuses the request;
 *   2. origin allowlist — requested (host, PORT) must exactly match an origin
 *      derived from the catalog url_templates (port defaulting to 443);
 *   3. routing headers — a caller Host / :authority is rejected (CLI owns Host);
 *   4. literal-IP SSRF block on the requested host;
 *   5. DNS resolve-validate-and-PIN — every resolved address must be public, and
 *      one validated address is pinned for the actual connection (rebind-proof).
 * Only THEN is the token read, (proactively) refreshed, attached, and sent (no
 * cross-domain redirect follow), with a single reactive-401 refresh+retry.
 *
 * @param {object} args
 *   - orgId, connection ({id, ...}), catalog (local action array), credential
 *   - catalogFetchedAt (ms epoch the catalog was fetched — freshness fail-closed)
 *   - domain (bare host[:port]), path, method, headers, query, body (caller)
 * @param {object} deps  fetchImpl, sendImpl, resolve, acquire, saveCache, now,
 *                       skewMs, catalogFreshnessMs, audit, log, warn
 */
export async function requestDirect(
  { orgId, connection, catalog, credential, catalogFetchedAt, domain, path, method, headers, query, body },
  deps = {},
) {
  const {
    fetchImpl, sendImpl = sendRawDirect, resolve = defaultResolve,
    acquire, saveCache = () => {}, now = Date.now,
    skewMs = DEFAULT_EXPIRY_SKEW_MS, catalogFreshnessMs = RAW_CATALOG_FRESHNESS_MS,
    audit = defaultAudit, log = () => {}, warn = () => {},
    // Lazy credential provider. When supplied, the credential is resolved/fetched
    // by calling this ONLY at step 6 — AFTER every credential-free gate below has
    // passed. This structurally guarantees an illegal request (stale catalog,
    // off-origin, bad path, private DNS resolution, …) never triggers a credential
    // read or fetch. When absent, the pre-supplied `credential` arg is used (the
    // unit-test path). getCredential may also enforce mode (throw on a proxy
    // connection) since that requires resolving the credential.
    getCredential,
  } = deps;

  // 0. Freshness FAIL-CLOSED. The allowlist is only as trustworthy as the catalog
  // it is derived from. A record with no numeric fetchedAt, one older than the
  // freshness window, OR one whose fetchedAt is in the FUTURE beyond a small
  // clock-skew tolerance is treated as stale/forged — REFUSE rather than
  // authorize off a stale (or a never-expiring future-stamped) host set. Freshness
  // requires a NON-NEGATIVE age within CATALOG_CLOCK_SKEW_MS, not merely
  // age ≤ window (a future timestamp would otherwise authorize forever).
  {
    const age = typeof catalogFetchedAt === 'number' && Number.isFinite(catalogFetchedAt)
      ? now() - catalogFetchedAt
      : null;
    if (age == null || age > catalogFreshnessMs || age < -CATALOG_CLOCK_SKEW_MS) {
      throw Object.assign(
        new Error('connection catalog is missing, stale, or has a future timestamp — refusing conn.request (fail-closed). Run conn.catalog {refresh:true} first, then retry.'),
        { status: 409 },
      );
    }
  }

  // 1. Allowed-ORIGIN set (host + port) from the local catalog.
  const allowedOrigins = allowedOriginsFromCatalog(catalog);
  if (allowedOrigins.size === 0) {
    throw Object.assign(
      new Error('no allowed origins could be derived from the connection catalog (empty / too-old catalog) — run conn.catalog {refresh:true}'),
      { status: 422 },
    );
  }

  // 2. Parse + GATE the target BEFORE the token is ever touched.
  const target = parseRequestTarget(domain);
  if (!target) {
    throw Object.assign(
      new Error(`invalid domain "${domain}" — expected a bare host like "api.example.com" (optionally host:port; no scheme / path / credentials)`),
      { status: 400 },
    );
  }
  // Origin match: (host, port) must be one the catalog warrants. A caller port not
  // in the allowed origin set (e.g. host:8443 when the catalog only warrants :443)
  // is rejected here — the token is never attached or sent.
  if (!allowedOrigins.has(originKey(target.hostname, target.port))) {
    throw Object.assign(
      new Error(`origin "${target.hostname}:${target.port}" is not in this connection's allowed origin set (host+port derived from the action-catalog url_templates; port defaults to 443) — refusing; the credential is never attached or sent`),
      { status: 403 },
    );
  }
  // 3. Reject caller routing-override headers (CLI owns Host).
  assertNoRoutingHeaders(headers);
  // 4. Literal-IP SSRF block on the requested host string.
  if (isDisallowedHost(target.hostname)) {
    throw Object.assign(
      new Error(`domain "${target.hostname}" is a blocked internal / metadata address — refusing`),
      { status: 403 },
    );
  }
  // 5. Resolve → require EVERY address public → PIN one for the connection. Still
  // before the token: a host that resolves to a private/CGNAT/loopback address (or
  // a rebind) is refused and the credential is never attached or sent.
  const pin = await resolveAndPin(target.hostname, resolve);

  // 6. Only NOW resolve/read the credential token (every credential-free gate has
  // passed). The lazy provider — when injected — is invoked HERE and nowhere
  // earlier, so an illegal request never triggers a credential resolution/fetch.
  let cred = credential;
  if (cred == null && typeof getCredential === 'function') {
    cred = await getCredential();
  }
  if (!cred || !cred.access_token) {
    throw Object.assign(
      new Error('no local direct-mode credential/access_token for this connection — conn.request requires a direct connection'),
      { status: 409 },
    );
  }
  const connId = connection && connection.id;

  // Proactive OAuth refresh — same policy as invokeDirect (api_key never touched).
  if (acquire && isTokenRefreshable(cred) && isTokenNearExpiry(cred, now(), skewMs)) {
    try {
      const fresh = await acquire(orgId, connId);
      if (fresh && fresh.access_token) { saveCache(connId, fresh); cred = fresh; }
      log(`[conn.request] refreshed near-expiry token conn=${connId}`);
    } catch (e) {
      warn(`[conn.request] proactive refresh failed conn=${connId}: ${e.message}`);
    }
  }

  // 7. Assemble (token attached HERE — after every gate) and send to the PINNED IP.
  let normPath = path == null ? '/' : String(path);
  if (!normPath.startsWith('/')) normPath = `/${normPath}`;
  const build = () => assembleRawRequest(
    { authority: target.authority, path, method, headers, query, body },
    cred.access_token, cred.token_type, cred.auth_injection,
  );
  let assembled = build();
  auditRawCall(assembled.method, target.authority, normPath, audit);
  let result = await sendImpl(assembled, { fetchImpl, pin });

  // 8. Reactive-401 refresh backstop (refreshable/OAuth only) — refresh once, retry.
  if (result.status_code === 401 && acquire && isTokenRefreshable(cred)) {
    log(`[conn.request] provider 401 conn=${connId}; reactive refresh + retry once`);
    const fresh = await acquire(orgId, connId);
    if (fresh && fresh.access_token) {
      saveCache(connId, fresh); cred = fresh;
      assembled = build();
      result = await sendImpl(assembled, { fetchImpl, pin });
    }
  }

  return result;
}
