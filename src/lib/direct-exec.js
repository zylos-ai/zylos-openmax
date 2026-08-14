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

/**
 * Inject the credential's auth into an assembled request, GENERICALLY (mirrors
 * cws-connect). Mutates `headers` in place and returns the (possibly updated)
 * URL — query-mode injection appends a pair to the URL. Two paths:
 *   - `authInjection` descriptor present ({ location, name, value_template }) →
 *     expand its literal "{token}" with the token, then place it. location
 *     'header' sets headers[name] (verbatim, dropping any same-name header
 *     case-insensitively first so the descriptor truly wins); location 'query'
 *     appends name=encodeURIComponent(expanded) to the URL's query string.
 *   - descriptor absent (today's 100% path) → set
 *     headers.Authorization = canonicalAuthScheme(tokenType) + ' ' + token.
 *
 * This is the SINGLE source of truth for host-side credential injection: both
 * catalog-driven assembleRequest (conn.invoke direct) and the free-path
 * passthrough (conn.request) call it, so the caller/LLM can never set auth.
 */
export function injectAuthHeaders(headers, url, { token, tokenType = '', authInjection = null } = {}) {
  if (authInjection && typeof authInjection === 'object' && authInjection.location && authInjection.name) {
    const vt = typeof authInjection.value_template === 'string' ? authInjection.value_template : '{token}';
    const expanded = vt.replace(/\{token\}/g, token == null ? '' : String(token));
    if (authInjection.location === 'query') {
      // Query value IS URL-encoded (it rides in the URL); header value is verbatim.
      return `${url}${url.includes('?') ? '&' : '?'}${authInjection.name}=${encodeURIComponent(expanded)}`;
    }
    // Drop any header of the SAME NAME case-insensitively before setting ours —
    // otherwise a template/caller `x-api-key` and an injected `X-API-Key` both
    // survive as distinct object keys and Node/fetch merges them into one
    // comma-joined value, so the descriptor would not truly win.
    const lower = authInjection.name.toLowerCase();
    for (const k of Object.keys(headers)) {
      if (k.toLowerCase() === lower) delete headers[k];
    }
    headers[authInjection.name] = expanded;
    return url;
  }
  headers.Authorization = `${canonicalAuthScheme(tokenType)} ${token}`;
  return url;
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
  // path taken by 100% of connections today. Extracted into injectAuthHeaders
  // so the direct-mode passthrough path (conn.request) injects credentials via
  // the EXACT same code (single source of truth for auth-header placement).
  url = injectAuthHeaders(headers, url, { token, tokenType, authInjection });

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
//  Audit logging (O6) — conn.invoke request log: ONLY the request path + mode.
// ---------------------------------------------------------------------------

// Mirrors client.js's RPC logging surfaces: stdout gated by COCO_RPC_LOG,
// file append gated by COCO_RPC_LOG_FILE. Tagged [conn.invoke] for grep.
export function defaultAudit(line) {
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

/**
 * Extract just the PATH portion of a url_template — no host, no query string,
 * no expanded params, so it can never carry a secret. Handles three shapes:
 *   - absolute URL  ("https://api.github.com/repos/{owner}/issues?x={y}") → "/repos/{owner}/issues"
 *   - {placeholder}-prefixed ("{base_url}/api/json?tree={t}")             → "/api/json"
 *   - already a bare path ("/user/repos")                                 → "/user/repos"
 * Placeholder tokens (e.g. "{owner}") are param NAMES, not values — left literal.
 */
export function urlTemplatePath(template) {
  const t = String(template || '');
  if (!t) return '';
  const noQuery = t.split('?')[0];
  const abs = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(noQuery);
  if (abs) return abs[1] || '/';
  const tpl = /^\{[^}]+\}(.*)$/.exec(noQuery);
  if (tpl) {
    const rest = tpl[1];
    const slash = rest.indexOf('/');
    return slash >= 0 ? rest.slice(slash) : (rest || '/');
  }
  return noQuery;
}

// conn.invoke per-call request log: the owner's contract is "only path and mode,
// print nothing else". No method, no url_template query, no params, no token.
function auditInvokeRequest(urlTemplate, audit) {
  audit(`[conn.invoke] path=${urlTemplatePath(urlTemplate)} mode=direct`);
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

// 3xx statuses that carry a `Location` we may (conditionally) follow.
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// Cap on how many redirect hops we follow before giving up (return the last 3xx).
export const MAX_REDIRECT_HOPS = 5;

/** The origin (scheme+host[+port]) of a URL, or null if it does not parse. */
function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

/** Read a single header from a fetch Response's headers (real Headers or a Map). */
function getResponseHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    return headers.get(name) ?? headers.get(name.toLowerCase()) ?? null;
  }
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (String(k).toLowerCase() === lower) return v;
  }
  return null;
}

/**
 * The per-request credential re-injection descriptor derived from a credential
 * record. Passed into sendDirect so a FOLLOWED redirect hop can re-inject the
 * credential freshly (headers are per-request; a query-mode credential must be
 * re-appended to the new hop's URL). Never carries the credential to a
 * non-allowed origin — sendDirect only re-injects on an origin that passed the
 * allow check.
 */
export function authReinjectInfo(cred) {
  return {
    token: cred && cred.access_token,
    tokenType: (cred && cred.token_type) || '',
    authInjection: (cred && cred.auth_injection) || null,
  };
}

/**
 * Send one assembled request and normalize the response into the server-parity
 * shape `{ status_code, headers, body }`. Raw passthrough — the provider body is
 * returned as parsed JSON when it parses, else as the raw string; it is never
 * transformed. The body is read with a streaming cap (see readCappedText): a
 * response over MAX_RESPONSE_BYTES throws (status 502) rather than being
 * buffered whole or silently truncated.
 *
 * SECURITY (P1) — redirects are NEVER auto-followed. `redirect: 'manual'` stops
 * fetch from silently re-sending the injected credential to whatever origin a
 * 3xx `Location` names (a credential exfiltration that would bypass the host
 * allowlist). We follow by hand, bounded to MAX_REDIRECT_HOPS, and ONLY when the
 * next hop's origin passes the same origin check as the initial request:
 *   - `isOriginAllowed(origin)` predicate — conn.request passes its derived host
 *     allowlist; when omitted we default to SAME-ORIGIN-ONLY (conn.invoke), i.e.
 *     the credential may only follow a redirect back to the request's own origin.
 *   - On a followed hop the credential is re-injected fresh via `reinject`.
 *   - On an off-allowlist (or unparseable/absent) Location we STOP and return the
 *     3xx response as-is (status + headers incl. Location, no body-follow) so the
 *     credential is never sent to a non-allowed origin.
 */
export async function sendDirect(
  assembled,
  { fetchImpl = fetch, isOriginAllowed, reinject = null, maxRedirects = MAX_REDIRECT_HOPS } = {},
) {
  const initialOrigin = originOf(assembled.url);
  const allowOrigin = typeof isOriginAllowed === 'function'
    ? isOriginAllowed
    : (o) => o != null && o === initialOrigin;

  const bodyInit = assembled.body !== undefined ? JSON.stringify(assembled.body) : undefined;

  let url = assembled.url;
  let headers = assembled.headers;
  let res = await fetchImpl(url, {
    method: assembled.method,
    headers,
    body: bodyInit,
    redirect: 'manual', // never auto-follow — we gate each hop below
  });

  for (let hops = 0; hops < maxRedirects && REDIRECT_STATUSES.has(res.status); hops += 1) {
    const location = getResponseHeader(res.headers, 'location');
    if (!location) break; // 3xx without a Location — nothing to follow; return as-is
    let nextUrl;
    let nextOrigin = null;
    try {
      nextUrl = new URL(location, url).toString();
      nextOrigin = new URL(nextUrl).origin;
    } catch { break; } // unparseable Location — return the 3xx as-is, no credential re-send
    // Off-allowlist target → STOP. Do NOT re-issue with the credential; returning
    // the 3xx as-is guarantees the credential never reaches a non-allowed origin.
    if (!allowOrigin(nextOrigin)) break;
    // Allowed: follow, re-injecting the credential FRESH for this hop.
    const nextHeaders = { ...assembled.headers };
    url = reinject ? injectAuthHeaders(nextHeaders, nextUrl, reinject) : nextUrl;
    headers = nextHeaders;
    res = await fetchImpl(url, {
      method: assembled.method,
      headers,
      body: bodyInit,
      redirect: 'manual',
    });
  }

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
  auditInvokeRequest(actionDef.url_template, audit);
  // conn.invoke has no multi-host allowlist → same-origin-only redirect guard
  // (sendDirect's default). reinject re-attaches the credential on a same-origin
  // hop; a cross-origin redirect is never followed with the credential.
  let result = await sendDirect(assembled, { fetchImpl, reinject: authReinjectInfo(cred) });

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
      result = await sendDirect(assembled, { fetchImpl, reinject: authReinjectInfo(cred) });
    }
  }

  return result;
}
