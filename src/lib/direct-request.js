/**
 * Direct-mode custom passthrough for cws-connect connections (conn.request, v1).
 *
 * Purpose: let the model call a provider method that is NOT a predefined action
 * — it supplies method/path/params and we assemble the URL, inject the auth
 * host-side, forward the request, and return the response — WITHOUT the model
 * ever seeing the credential. This complements catalog-driven `conn.invoke`
 * (direct-exec.js) for the long tail of endpoints that have no catalog action.
 *
 * SECURITY RED LINE — this path is deliberately more permissive than
 * `conn.invoke` (the caller supplies a free-form path + query, not a catalog
 * action), so it is fenced by a HOST ALLOWLIST derived from the connector's OWN
 * action catalog:
 *   - The caller may NOT supply an absolute URL — only a RELATIVE path.
 *   - The target origin (scheme+host[+port]) must be a member of the allowlist,
 *     which is the set of origins parsed from every catalog action's
 *     `url_template` (with `{base_url}`-style placeholders resolved from the
 *     connection's url_placeholders), plus the connection's own `{base_url}`
 *     origin, plus an optional small per-connector `extra_hosts` list. This
 *     locks the token to the connector's own API domains — a model-chosen
 *     foreign host can never have the credential auto-attached to it.
 *   - The caller may NOT set auth headers (Authorization/Cookie/…): those are
 *     rejected; the real credential is injected host-side via the SAME
 *     injectAuthHeaders() code path `conn.invoke` uses.
 *   - DIRECT MODE ONLY: a proxy-mode connection is rejected (use conn.invoke).
 *
 * Pure-ish: `fetch`, `acquire`, and `saveCache` are injectable so this is unit
 * testable without network or disk. No import-time side effects.
 */

import {
  canonicalAuthScheme,        // re-exported for callers/tests that want the scheme
  injectAuthHeaders,
  sendDirect,
  authReinjectInfo,
  isTokenRefreshable,
  isTokenNearExpiry,
  DEFAULT_EXPIRY_SKEW_MS,
  defaultAudit,
} from './direct-exec.js';
import { redactSecrets } from './redact.js';

export { canonicalAuthScheme };

// HTTP verbs the passthrough accepts. Kept intentionally small (no TRACE/CONNECT
// /OPTIONS): these six cover every real provider call and avoid odd methods.
export const METHOD_ALLOWLIST = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

// Methods that carry a JSON body built from the `body` param.
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Caller-supplied headers with any of these (case-insensitive, hyphen/underscore
// -normalized) names are REJECTED — auth is ours to inject, never the model's to
// set. A comprehensive static list of common credential-bearing headers so the
// "caller-supplied auth headers are rejected" guarantee is not a fragile 4-item
// list (a caller could otherwise smuggle a token via X-API-Key, Private-Token, …).
const AUTH_HEADER_DENYLIST = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-csrf-token', 'x-xsrf-token',
  'x-api-key', 'api-key', 'apikey',
  'x-auth-token', 'x-auth', 'auth-token', 'access-token', 'x-access-token',
  'private-token', 'x-amz-security-token',
  'authentication', 'www-authenticate', 'proxy-authenticate',
]);

// Conservative catch-all for obvious credential header-name segments not in the
// static list. Matches credential-ish tokens delimited by start/end or a
// hyphen/underscore, so it targets real auth headers (client-secret, x-foo-apikey,
// user-password) WITHOUT snaring legit non-auth headers such as Idempotency-Key,
// Accept, Content-Type, or X-GitHub-Api-Version.
const CREDENTIAL_HEADER_RE = new RegExp(
  '(?:^|[-_])(?:'
    + 'api[-_]?key|access[-_]?token|auth[-_]?token|private[-_]?token'
    + '|x[-_]auth|secret|password|credential'
  + ')s?(?:[-_]|$)',
  'i',
);

/**
 * Is this caller-supplied header name one we must reject? Rejects (a) the static
 * denylist, (b) the connection's ACTUAL injected auth header name (`injectedName`,
 * from auth_injection.name, whatever it is called), and (c) the conservative
 * credential-segment catch-all. All checks run on both the lowercased name and a
 * hyphen-normalized variant (so `x_api_key` is caught like `x-api-key`).
 */
function isRejectedCallerHeader(name, injectedName) {
  const lower = String(name == null ? '' : name).trim().toLowerCase();
  if (!lower) return false;
  const norm = lower.replace(/_/g, '-');
  if (AUTH_HEADER_DENYLIST.has(lower) || AUTH_HEADER_DENYLIST.has(norm)) return true;
  if (injectedName) {
    const inj = String(injectedName).trim().toLowerCase();
    const injNorm = inj.replace(/_/g, '-');
    if (inj && (lower === inj || norm === injNorm)) return true;
  }
  return CREDENTIAL_HEADER_RE.test(lower) || CREDENTIAL_HEADER_RE.test(norm);
}

// Response headers we pass back to the caller — a small, safe subset (never
// set-cookie / authorization / anything credential-bearing). These are the ones
// a model actually needs: content typing, caching/validators, redirects, rate
// limits, and pagination (GitHub-style Link).
const SAFE_RESPONSE_HEADERS = new Set([
  'content-type', 'content-length', 'etag', 'last-modified',
  'location', 'retry-after', 'link',
]);

function hasVal(v) {
  return v !== undefined && v !== null && v !== '';
}

function statusErr(message, status) {
  return Object.assign(new Error(message), { status });
}

/**
 * conn.request is a DIRECT-NATIVE escape hatch: it has a local token to inject
 * and its host allowlist is derived from the connection's own catalog. A
 * non-direct connection has neither, so there is nothing for this path to do —
 * we log a concise line and return a neutral skip result (no throw, and nothing
 * about credential modes is surfaced to the caller).
 */
export function skipNonDirect({ connectionId, slug } = {}, audit = defaultAudit) {
  audit(`[conn.request] connection ${connectionId} (app ${slug}) not direct-mode — skipped`);
  return { skipped: true, reason: 'not-direct' };
}

// ---------------------------------------------------------------------------
//  Host-allowlist derivation (from the connector's OWN action catalog)
// ---------------------------------------------------------------------------

/**
 * Resolve a (possibly templated) url_template string to its origin
 * (scheme+host[+port]). `{placeholder}` tokens are substituted VERBATIM from
 * `urlPlaceholders` first (so a "{base_url}/api/…" template resolves to a
 * concrete origin); any still-unresolved placeholder BEFORE the host makes the
 * origin unparseable → null. Placeholders inside the path (e.g. "{owner}") are
 * harmless — the URL parser tolerates them and `.origin` ignores the path.
 */
export function resolveTemplateOrigin(template, urlPlaceholders = {}) {
  let s = String(template || '');
  if (!s) return null;
  const uph = (urlPlaceholders && typeof urlPlaceholders === 'object') ? urlPlaceholders : {};
  s = s.replace(/\{([^}]+)\}/g, (full, key) => (hasVal(uph[key]) ? String(uph[key]) : full));
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // relative, or host still templated
  try { return new URL(s).origin; } catch { return null; }
}

/** Normalize an extra-host entry ("host" or "https://host[:port]") to an origin. */
export function normalizeHostToOrigin(h) {
  const s = String(h == null ? '' : h).trim();
  if (!s) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`).origin;
  } catch { return null; }
}

/**
 * Gather optional per-connector extra hosts. There is no natural catalog field
 * for these, so a small documented one is honored from either the credential
 * record (`extra_hosts`, or `url_placeholders.extra_hosts`) or the connection
 * index entry (`extraHosts`). Each may be a string or an array of strings.
 */
export function collectExtraHosts(credential, connection) {
  const out = [];
  const push = (v) => {
    if (Array.isArray(v)) out.push(...v);
    else if (hasVal(v)) out.push(v);
  };
  push(credential && credential.extra_hosts);
  push(credential && credential.url_placeholders && credential.url_placeholders.extra_hosts);
  push(connection && connection.extraHosts);
  return out.filter((x) => typeof x === 'string');
}

/**
 * Derive the host allowlist for a connection's custom passthrough:
 *   allowlist = { origin(url_template) : every action in the catalog }
 *             ∪ origin(connection.url_placeholders.base_url)   (if present)
 *             ∪ { normalized extra_hosts }                      (if any)
 *
 * Returns `{ allowlist: Set<string>, primary: string|null }`. `primary` is the
 * default target origin when the caller gives no `host`: the connection's own
 * `{base_url}` origin if it has one (self-hosted connectors), else the first
 * resolvable action origin (SaaS connectors — a single primary API host).
 */
export function deriveHostAllowlist({ catalog = [], urlPlaceholders = {}, extraHosts = [] } = {}) {
  const uph = (urlPlaceholders && typeof urlPlaceholders === 'object') ? urlPlaceholders : {};
  const allowlist = new Set();

  let primary = null;
  if (hasVal(uph.base_url)) {
    const o = resolveTemplateOrigin(uph.base_url, uph);
    if (o) { allowlist.add(o); primary = o; }
  }
  for (const action of Array.isArray(catalog) ? catalog : []) {
    const o = resolveTemplateOrigin(action && action.url_template, uph);
    if (o) {
      allowlist.add(o);
      if (!primary) primary = o;
    }
  }
  for (const h of Array.isArray(extraHosts) ? extraHosts : []) {
    const o = normalizeHostToOrigin(h);
    if (o) allowlist.add(o);
  }
  return { allowlist, primary };
}

// ---------------------------------------------------------------------------
//  Request assembly (code-driven; caller supplies method/path/query/body only)
// ---------------------------------------------------------------------------

/**
 * Assemble the concrete passthrough request, throwing (with a status) on any
 * validation failure. Returns `{ method, url, headers, body, origin }`.
 *
 * Rules enforced here:
 *   - `method` must be in METHOD_ALLOWLIST (400).
 *   - `path` must be a RELATIVE path with a leading "/"; an absolute URL
 *     (scheme://… or protocol-relative //…) is rejected (400).
 *   - `origin` = normalized `host` if given, else `primaryOrigin`; it MUST be a
 *     member of `allowlist`, else rejected (400, listing the allowed hosts).
 *   - caller `headers` carrying an auth header (AUTH_HEADER_DENYLIST) → 400.
 *   - `query` is merged onto any query already present in `path`, values
 *     percent-encoded; the path portion is used verbatim (the caller owns it,
 *     as with a {base_url} prefix — encoding it would corrupt it).
 *   - auth is injected host-side via injectAuthHeaders (never from the caller).
 *   - a JSON `body` is attached for body-bearing methods only.
 */
export function assemblePassthroughRequest({
  method, path, host, query = {}, body, headers = {},
  token, tokenType = '', authInjection = null,
  allowlist, primaryOrigin,
}) {
  const m = String(method || '').toUpperCase();
  if (!METHOD_ALLOWLIST.has(m)) {
    throw statusErr(`method "${method}" not allowed — use one of ${[...METHOD_ALLOWLIST].join(', ')}`, 400);
  }

  if (typeof path !== 'string' || !path) throw statusErr('path is required (a relative path with a leading "/")', 400);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path) || path.startsWith('//')) {
    throw statusErr('path must be a RELATIVE path, not an absolute URL — the host is derived from the connection, not supplied by the caller', 400);
  }
  if (!path.startsWith('/')) throw statusErr('path must start with "/"', 400);

  const origin = hasVal(host) ? normalizeHostToOrigin(host) : primaryOrigin;
  if (!origin) throw statusErr('could not determine a target host for this connection', 400);
  if (!(allowlist instanceof Set) || !allowlist.has(origin)) {
    const allowed = allowlist instanceof Set ? [...allowlist].join(', ') : '(none)';
    throw statusErr(`host "${origin}" is not in this connection's allowlist — allowed hosts: ${allowed}`, 400);
  }

  // Merge query: keep any query already in `path` verbatim, append the `query`
  // object's pairs (percent-encoded, arrays repeated).
  const qIdx = path.indexOf('?');
  const pathPart = qIdx >= 0 ? path.slice(0, qIdx) : path;
  const existingQuery = qIdx >= 0 ? path.slice(qIdx + 1) : '';
  const pairs = existingQuery ? existingQuery.split('&').filter(Boolean) : [];
  for (const [k, v] of Object.entries(query && typeof query === 'object' ? query : {})) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(item))}`);
    } else {
      pairs.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
    }
  }
  let url = origin + pathPart + (pairs.length ? `?${pairs.join('&')}` : '');

  // Non-auth headers only. A caller-supplied auth header is a hard error — the
  // static denylist, the connection's own injected header name, and the
  // credential-segment catch-all all reject. Message stays mode-neutral (no
  // "host-side"/"server-side"/credential-mode vocabulary).
  const outHeaders = {};
  const injectedName = authInjection && authInjection.name;
  for (const [hk, hv] of Object.entries(headers && typeof headers === 'object' ? headers : {})) {
    if (isRejectedCallerHeader(hk, injectedName)) {
      throw statusErr(`caller may not set the "${hk}" header — authentication is injected for you`, 400);
    }
    outHeaders[hk] = String(hv);
  }

  // Inject the credential via the EXACT same code as conn.invoke (direct-exec).
  url = injectAuthHeaders(outHeaders, url, { token, tokenType, authInjection });

  // Body — JSON, body-bearing methods only.
  let outBody;
  if (body !== undefined && body !== null && BODY_METHODS.has(m)) {
    outBody = body;
    if (!Object.keys(outHeaders).some((h) => h.toLowerCase() === 'content-type')) {
      outHeaders['Content-Type'] = 'application/json';
    }
  }

  return { method: m, url, headers: outHeaders, body: outBody, origin, pathPart };
}

// ---------------------------------------------------------------------------
//  Audit — origin + path only, secrets redacted. NEVER the assembled URL (a
//  query-mode auth_injection would put the token in the query string), NEVER
//  the token or headers.
// ---------------------------------------------------------------------------

function auditRequest(method, origin, pathPart, query, audit) {
  const safeQuery = JSON.stringify(redactSecrets(query || {}));
  audit(`[conn.request] → ${method} ${origin}${pathPart} query: ${safeQuery}`);
}

function pickSafeResponseHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (SAFE_RESPONSE_HEADERS.has(String(k).toLowerCase())) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Orchestration — derive allowlist → assemble → (proactive refresh) → send →
//  (reactive-401 refresh once) → return { status, body, headers }.
// ---------------------------------------------------------------------------

/**
 * Full direct-mode passthrough. Mirrors invokeDirect's token lifecycle
 * (proactive OAuth refresh on near-expiry, one reactive refresh on a provider
 * 401) and its raw-passthrough result parity, but assembles the request from a
 * caller-supplied method/path/query/body fenced by the derived host allowlist
 * instead of a catalog action.
 *
 * @param {object} args
 *   - orgId, connection ({id, applicationId, slug, extraHosts?})
 *   - method, path, host?, query?, body?, headers?   (the caller's request)
 *   - catalog: the action array (its url_templates seed the host allowlist)
 *   - credential: the cached credential record (access_token, token_type,
 *                 url_placeholders, auth_injection, extra_hosts?, …)
 * @param {object} deps  fetchImpl, acquire, saveCache, now, skewMs, audit, log, warn
 * @returns {Promise<{status:number, body:*, headers:object}>}
 */
export async function invokeDirectRequest(
  { orgId, connection, method, path, host, query, body, headers, catalog, credential },
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

  let cred = credential;
  const connId = connection && connection.id;
  const urlPlaceholders = (cred && cred.url_placeholders) || {};
  const extraHosts = collectExtraHosts(cred, connection);

  const { allowlist, primary } = deriveHostAllowlist({ catalog, urlPlaceholders, extraHosts });
  if (allowlist.size === 0) {
    // No action carried a resolvable url_template and there is no base_url — the
    // cached catalog is too old for host-allowlist derivation (predates
    // url_template). Signal a refresh, same convention as invokeDirect's 422.
    throw statusErr('cannot derive a host allowlist for this connection — the local catalog is too old (run conn.catalog {refresh:true})', 422);
  }

  const build = () => assemblePassthroughRequest({
    method, path, host, query, body, headers,
    token: cred && cred.access_token,
    tokenType: cred && cred.token_type,
    authInjection: cred && cred.auth_injection,
    allowlist,
    primaryOrigin: primary,
  });

  // Assemble/validate ONCE up front so an invalid request (bad method, absolute
  // URL, off-allowlist host, caller auth header) fails before any refresh/network.
  let assembled = build();

  // Proactive refresh: refreshable (OAuth) tokens carrying a near/expired
  // expires_at only. Non-fatal on failure — fall through to the reactive path.
  if (acquire && isTokenRefreshable(cred) && isTokenNearExpiry(cred, now(), skewMs)) {
    try {
      const fresh = await acquire(orgId, connId);
      if (fresh && fresh.access_token) { saveCache(connId, fresh); cred = fresh; assembled = build(); }
      log(`[conn.request] refreshed near-expiry token conn=${connId}`);
    } catch (e) {
      warn(`[conn.request] proactive refresh failed conn=${connId}: ${e.message}`);
    }
  }

  // Redirects are gated by the SAME host allowlist as the initial request: a 3xx
  // to an off-allowlist origin is NOT followed with the credential (P1). reinject
  // re-attaches the credential on each followed (in-allowlist) hop.
  const isOriginAllowed = (o) => allowlist.has(o);
  auditRequest(assembled.method, assembled.origin, assembled.pathPart, query, audit);
  let result = await sendDirect(assembled, { fetchImpl, isOriginAllowed, reinject: authReinjectInfo(cred) });

  // Reactive-401 backstop (refreshable/OAuth only): refresh ONCE and retry.
  if (result.status_code === 401 && acquire && isTokenRefreshable(cred)) {
    log(`[conn.request] provider 401 conn=${connId}; reactive refresh + retry once`);
    const fresh = await acquire(orgId, connId); // if refresh itself throws, surface it
    if (fresh && fresh.access_token) {
      saveCache(connId, fresh);
      cred = fresh;
      assembled = build();
      auditRequest(assembled.method, assembled.origin, assembled.pathPart, query, audit);
      result = await sendDirect(assembled, { fetchImpl, isOriginAllowed, reinject: authReinjectInfo(cred) });
    }
  }

  // Result parity with the server execute path, but keyed `status` (not
  // `status_code`) and with only a safe subset of response headers surfaced.
  return {
    status: result.status_code,
    body: result.body,
    headers: pickSafeResponseHeaders(result.headers),
  };
}
