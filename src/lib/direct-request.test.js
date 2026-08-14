import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveTemplateOrigin,
  normalizeHostToOrigin,
  collectExtraHosts,
  deriveHostAllowlist,
  assemblePassthroughRequest,
  invokeDirectRequest,
  skipNonDirect,
  METHOD_ALLOWLIST,
} from './direct-request.js';

// Silence the audit sink (writes to stderr by default).
const quietAudit = () => {};

// A fetch double mirroring direct-exec.test.js: Response-like with status,
// JSON/text body and Headers, exposing a real ReadableStream so the capped-read
// path is exercised. Records calls for end-to-end assembly assertions.
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(bodyText);
    return {
      status: r.status ?? 200,
      headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => bodyText,
    };
  };
  return { impl, calls };
}

// A fetch double that models NATIVE fetch redirect-following (see direct-exec.test.js).
// A 3xx route with a Location auto-follows (re-sending the SAME headers — the leak)
// UNLESS the caller passed redirect:'manual'. Records every hop's url + headers.
function redirectingFetch(routes) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts, headers: opts.headers });
    const r = routes[url] || { status: 404, body: {} };
    const status = r.status ?? 200;
    const loc = r.headers && (r.headers.location || r.headers.Location);
    if (loc && status >= 300 && status < 400 && opts.redirect !== 'manual') {
      return impl(new URL(loc, url).toString(), opts);
    }
    const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(bodyText);
    return {
      status,
      headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => bodyText,
    };
  };
  return { impl, calls };
}

// A GitHub-shaped catalog: two SaaS actions on api.github.com, seeding the host
// allowlist purely from their url_templates.
const GH_CATALOG = [
  { toolkit: 'github-repos', action: 'list', method: 'GET', url_template: 'https://api.github.com/user/repos?per_page={per_page}', input_schema: '' },
  { toolkit: 'github-issues', action: 'create', method: 'POST', url_template: 'https://api.github.com/repos/{owner}/{repo}/issues', input_schema: '' },
];

const GH_CRED = { credential_mode: 'direct', token_type: 'bearer', access_token: 'GHTOK' };

// ---------------------------------------------------------------------------
//  Host-allowlist derivation
// ---------------------------------------------------------------------------

test('resolveTemplateOrigin: SaaS template → origin; path placeholders are harmless', () => {
  assert.equal(resolveTemplateOrigin('https://api.github.com/repos/{owner}/{repo}/issues'), 'https://api.github.com');
  assert.equal(resolveTemplateOrigin('https://uploads.github.com/x'), 'https://uploads.github.com');
});

test('resolveTemplateOrigin: {base_url} is resolved verbatim from url_placeholders', () => {
  assert.equal(
    resolveTemplateOrigin('{base_url}/api/json?tree={tree}', { base_url: 'https://jenkins.example.com:8443' }),
    'https://jenkins.example.com:8443',
  );
});

test('resolveTemplateOrigin: an unresolved host-leading placeholder → null (not parseable)', () => {
  assert.equal(resolveTemplateOrigin('{base_url}/api/json', {}), null);
  assert.equal(resolveTemplateOrigin('/relative/only'), null);
  assert.equal(resolveTemplateOrigin(''), null);
});

test('normalizeHostToOrigin: bare host defaults to https; scheme preserved', () => {
  assert.equal(normalizeHostToOrigin('uploads.github.com'), 'https://uploads.github.com');
  assert.equal(normalizeHostToOrigin('http://localhost:9000'), 'http://localhost:9000');
  assert.equal(normalizeHostToOrigin(''), null);
});

test('collectExtraHosts: from credential.extra_hosts, url_placeholders.extra_hosts, and connection.extraHosts', () => {
  const cred = { extra_hosts: ['a.example.com'], url_placeholders: { extra_hosts: 'b.example.com' } };
  const conn = { extraHosts: ['c.example.com', 'd.example.com'] };
  assert.deepEqual(collectExtraHosts(cred, conn), ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com']);
  assert.deepEqual(collectExtraHosts(null, null), []);
});

test('deriveHostAllowlist: SaaS catalog → single api origin as allowlist + primary', () => {
  const { allowlist, primary } = deriveHostAllowlist({ catalog: GH_CATALOG });
  assert.deepEqual([...allowlist], ['https://api.github.com']);
  assert.equal(primary, 'https://api.github.com');
});

test('deriveHostAllowlist: base_url is the primary and is unioned in; extra_hosts unioned', () => {
  const { allowlist, primary } = deriveHostAllowlist({
    catalog: [{ url_template: '{base_url}/api/json?tree={tree}' }],
    urlPlaceholders: { base_url: 'https://jenkins.example.com' },
    extraHosts: ['artifacts.example.com'],
  });
  assert.equal(primary, 'https://jenkins.example.com');
  assert.deepEqual([...allowlist].sort(), ['https://artifacts.example.com', 'https://jenkins.example.com']);
});

test('deriveHostAllowlist: multiple distinct action origins all appear', () => {
  const { allowlist } = deriveHostAllowlist({
    catalog: [
      { url_template: 'https://api.github.com/user' },
      { url_template: 'https://uploads.github.com/x' },
    ],
  });
  assert.deepEqual([...allowlist].sort(), ['https://api.github.com', 'https://uploads.github.com']);
});

// ---------------------------------------------------------------------------
//  Request assembly + validation
// ---------------------------------------------------------------------------

const GH_ALLOW = deriveHostAllowlist({ catalog: GH_CATALOG });

function assembleGh(overrides = {}) {
  return assemblePassthroughRequest({
    method: 'GET', path: '/user/repos', token: 'GHTOK', tokenType: 'bearer',
    allowlist: GH_ALLOW.allowlist, primaryOrigin: GH_ALLOW.primary,
    ...overrides,
  });
}

test('assemble: primary origin + relative path + merged query, Bearer injected', () => {
  const req = assembleGh({ path: '/user/repos?type=owner', query: { per_page: 10, visibility: ['public', 'private'] } });
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://api.github.com/user/repos?type=owner&per_page=10&visibility=public&visibility=private');
  assert.equal(req.headers.Authorization, 'Bearer GHTOK');
  assert.equal(req.body, undefined);
  assert.equal(req.origin, 'https://api.github.com');
});

test('assemble: an absolute URL path is rejected (400) — caller cannot supply a host', () => {
  assert.throws(() => assembleGh({ path: 'https://evil.example.com/x' }), (e) => e.status === 400 && /RELATIVE/.test(e.message));
  assert.throws(() => assembleGh({ path: '//evil.example.com/x' }), (e) => e.status === 400);
});

test('assemble: a path without a leading slash is rejected (400)', () => {
  assert.throws(() => assembleGh({ path: 'user/repos' }), (e) => e.status === 400 && /start with/.test(e.message));
});

test('assemble: a method outside the allowlist is rejected (400)', () => {
  assert.throws(() => assembleGh({ method: 'OPTIONS' }), (e) => e.status === 400 && /not allowed/.test(e.message));
  assert.ok(METHOD_ALLOWLIST.has('HEAD'));
});

test('assemble: an off-allowlist host is rejected (400) and the message lists allowed hosts', () => {
  assert.throws(
    () => assembleGh({ host: 'evil.example.com' }),
    (e) => e.status === 400 && /not in this connection's allowlist/.test(e.message) && /api\.github\.com/.test(e.message),
  );
});

test('assemble: an allowlisted non-primary host param is honored', () => {
  const allow = deriveHostAllowlist({ catalog: GH_CATALOG, extraHosts: ['uploads.github.com'] });
  const req = assemblePassthroughRequest({
    method: 'POST', path: '/repo/releases/1/assets', host: 'uploads.github.com', body: { x: 1 },
    token: 'T', tokenType: 'bearer', allowlist: allow.allowlist, primaryOrigin: allow.primary,
  });
  assert.equal(req.url, 'https://uploads.github.com/repo/releases/1/assets');
  assert.equal(req.origin, 'https://uploads.github.com');
});

test('assemble: caller-supplied auth headers are rejected (400)', () => {
  for (const h of [{ Authorization: 'Bearer EVIL' }, { cookie: 'x=y' }, { 'Proxy-Authorization': 'z' }]) {
    assert.throws(() => assembleGh({ headers: h }), (e) => e.status === 400 && /may not set/.test(e.message));
  }
});

test('assemble: non-auth caller headers pass through; body attaches on write methods with Content-Type', () => {
  const req = assembleGh({ method: 'POST', path: '/repos/o/r/issues', headers: { 'X-Trace': 'abc' }, body: { title: 'Bug' } });
  assert.equal(req.headers['X-Trace'], 'abc');
  assert.deepEqual(req.body, { title: 'Bug' });
  assert.equal(req.headers['Content-Type'], 'application/json');
});

test('assemble: GET ignores a body', () => {
  const req = assembleGh({ method: 'GET', body: { nope: 1 } });
  assert.equal(req.body, undefined);
});

test('assemble: auth_injection descriptor places the credential and emits NO Authorization', () => {
  const req = assemblePassthroughRequest({
    method: 'GET', path: '/user/repos', token: 'KEY', tokenType: 'api_key',
    authInjection: { location: 'header', name: 'X-API-Key', value_template: '{token}' },
    allowlist: GH_ALLOW.allowlist, primaryOrigin: GH_ALLOW.primary,
  });
  assert.equal(req.headers['X-API-Key'], 'KEY');
  assert.equal(req.headers.Authorization, undefined);
});

// ---------------------------------------------------------------------------
//  Non-direct skip — conn.request stays direct-only: a non-direct connection is
//  logged + neutrally skipped (no throw, no credential-mode detail surfaced).
// ---------------------------------------------------------------------------

test('skipNonDirect: returns the neutral { skipped, reason } result', () => {
  const out = skipNonDirect({ connectionId: 'c-1', slug: 'github' }, () => {});
  assert.deepEqual(out, { skipped: true, reason: 'not-direct' });
});

test('skipNonDirect: logs a concise "not direct-mode — skipped" line with connId + slug', () => {
  const lines = [];
  skipNonDirect({ connectionId: 'c-1', slug: 'github' }, (l) => lines.push(l));
  assert.deepEqual(lines, ['[conn.request] connection c-1 (app github) not direct-mode — skipped']);
});

// ---------------------------------------------------------------------------
//  Orchestration (invokeDirectRequest)
// ---------------------------------------------------------------------------

test('invokeDirectRequest: happy path → { status, body, headers (safe subset) }, token on the wire', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { repos: [] }, headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '4999', 'set-cookie': 'secret=1' } });
  const out = await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/user/repos', query: { per_page: 5 }, catalog: GH_CATALOG, credential: GH_CRED },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(out.status, 200);
  assert.deepEqual(out.body, { repos: [] });
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(out.headers['set-cookie'], undefined, 'set-cookie must never be surfaced');
  assert.equal(calls[0].url, 'https://api.github.com/user/repos?per_page=5');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer GHTOK');
});

test('invokeDirectRequest: a provider error status is passed through, not thrown', async () => {
  const { impl } = fakeFetch({ status: 404, body: { message: 'Not Found' } });
  const out = await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/nope', catalog: GH_CATALOG, credential: { ...GH_CRED, token_type: 'api_key' } },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(out.status, 404);
  assert.deepEqual(out.body, { message: 'Not Found' });
});

test('invokeDirectRequest: an empty/too-old catalog (no allowlist) → 422, never sends', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirectRequest(
      { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/x', catalog: [], credential: GH_CRED },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 422 && /allowlist/.test(e.message),
  );
  assert.equal(calls.length, 0);
});

test('invokeDirectRequest: off-allowlist host → 400 before any send', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirectRequest(
      { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/x', host: 'evil.example.com', catalog: GH_CATALOG, credential: GH_CRED },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 400,
  );
  assert.equal(calls.length, 0, 'no request may reach an off-allowlist host');
});

test('invokeDirectRequest: provider 401 on OAuth → reactive refresh ONCE, retry with new token', async () => {
  const { impl, calls } = fakeFetch([
    { status: 401, body: { message: 'Bad credentials' } },
    { status: 200, body: { ok: true } },
  ]);
  let acquires = 0;
  const out = await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/user/repos', catalog: GH_CATALOG, credential: { ...GH_CRED, access_token: 'OLD' } },
    { fetchImpl: impl, acquire: async () => { acquires++; return { credential_mode: 'direct', token_type: 'bearer', access_token: 'NEW' }; }, audit: quietAudit },
  );
  assert.equal(acquires, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer NEW');
  assert.equal(out.status, 200);
});

test('invokeDirectRequest: api_key 401 is NOT refreshed — surfaced as-is', async () => {
  const { impl, calls } = fakeFetch({ status: 401, body: { message: 'bad key' } });
  let acquires = 0;
  const out = await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/user/repos', catalog: GH_CATALOG, credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY' } },
    { fetchImpl: impl, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0);
  assert.equal(calls.length, 1);
  assert.equal(out.status, 401);
});

test('invokeDirectRequest: audit logs origin + path only, never the token or the query secret', async () => {
  const { impl } = fakeFetch({ status: 200, body: {} });
  const lines = [];
  await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/user/repos', query: { access_token: 'SUPERSECRET' }, catalog: GH_CATALOG, credential: { ...GH_CRED, access_token: 'GHTOK-SECRET' } },
    { fetchImpl: impl, audit: (l) => lines.push(l) },
  );
  const joined = lines.join('\n');
  assert.ok(lines.length >= 1, 'a call must produce an audit line');
  assert.ok(joined.includes('https://api.github.com/user/repos'), 'audit logs origin + path');
  assert.ok(!joined.includes('GHTOK-SECRET'), 'audit must never leak the token');
  assert.ok(!joined.includes('SUPERSECRET'), 'audit redacts secret-shaped query values');
});

test('invokeDirectRequest: self-hosted connector uses {base_url} as its primary + allowlist', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { jobs: [] } });
  const cred = { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY', url_placeholders: { base_url: 'https://jenkins.example.com' } };
  const catalog = [{ toolkit: 'jenkins', action: 'jobs', method: 'GET', url_template: '{base_url}/api/json?tree={tree}', input_schema: '' }];
  const out = await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/queue/api/json', catalog, credential: cred },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(calls[0].url, 'https://jenkins.example.com/queue/api/json');
  assert.equal(out.status, 200);
});

// ---------------------------------------------------------------------------
//  P1 — redirect must NOT leak the injected credential past the host allowlist.
//  The reviewer's scenario: an allowlisted origin 302s to an OFF-allowlist origin;
//  the credential must never be re-sent to that origin.
// ---------------------------------------------------------------------------

test('P1 invokeDirectRequest: an in-allowlist origin 302 → OFF-allowlist origin is NOT followed; credential never re-sent', async () => {
  // WITHOUT the fix, native-fetch auto-follow re-sends Authorization to evil (leak);
  // WITH the fix (redirect:manual + allowlist origin guard) sendDirect returns the 302.
  const { impl, calls } = redirectingFetch({
    'https://api.github.com/user/repos': { status: 302, headers: { location: 'https://evil.example.com/steal' } },
    'https://evil.example.com/steal': { status: 200, body: { stolen: true } },
  });
  const out = await invokeDirectRequest(
    { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, method: 'GET', path: '/user/repos', catalog: GH_CATALOG, credential: { ...GH_CRED, access_token: 'GHTOK-SECRET' } },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(out.status, 302, 'the off-allowlist 3xx is returned as-is, not followed');
  assert.equal(out.headers.location, 'https://evil.example.com/steal', 'Location is surfaced (a safe response header)');
  assert.equal(calls.length, 1, 'only the initial in-allowlist request is issued');
  const leaked = calls.filter((c) => c.url.includes('evil.example.com') && c.headers && c.headers.Authorization);
  assert.equal(leaked.length, 0, 'the injected credential must NEVER reach the off-allowlist origin');
});

test('P1 invokeDirectRequest: an IN-allowlist redirect IS followed with the credential re-injected', async () => {
  const { impl, calls } = redirectingFetch({
    'https://api.github.com/user/repos': { status: 302, headers: { location: 'https://uploads.github.com/user/repos' } },
    'https://uploads.github.com/user/repos': { status: 200, body: { ok: true } },
  });
  const out = await invokeDirectRequest(
    // uploads.github.com is unioned into the allowlist via the connection's extraHosts.
    { orgId: 'o', connection: { id: 'c', applicationId: 'a', extraHosts: ['uploads.github.com'] }, method: 'GET', path: '/user/repos', catalog: GH_CATALOG, credential: GH_CRED },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(out.status, 200, 'the in-allowlist redirect is followed');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.redirect, 'manual', 'fetch is told not to auto-follow');
  assert.equal(calls[1].url, 'https://uploads.github.com/user/repos');
  assert.equal(calls[1].headers.Authorization, 'Bearer GHTOK', 'credential is re-injected on the followed in-allowlist hop');
});

// ---------------------------------------------------------------------------
//  P2 — caller auth-header rejection is comprehensive (not a fragile 4-item list)
//  yet does not snare legit non-auth headers.
// ---------------------------------------------------------------------------

test('P2 assemble: common credential headers are rejected (X-API-Key / Api-Key / Private-Token / X-Auth-Token / …)', () => {
  for (const name of ['X-API-Key', 'Api-Key', 'apikey', 'Private-Token', 'X-Auth-Token', 'Access-Token', 'X-Amz-Security-Token', 'x_api_key', 'Client-Secret', 'X-User-Password']) {
    assert.throws(
      () => assembleGh({ headers: { [name]: 'sneaky' } }),
      (e) => e.status === 400 && /may not set/.test(e.message) && !/host-side|server-side|proxy|direct/i.test(e.message),
      `${name} must be rejected with a mode-neutral message`,
    );
  }
});

test('P2 assemble: the connection\'s own auth_injection.name is rejected (whatever it is called, incl. _ variant)', () => {
  const authInjection = { location: 'header', name: 'X-Custom-Key', value_template: '{token}' };
  // X-Custom-Key is not in the static list nor caught by the regex — only the
  // dynamic injected-name check rejects it (and its hyphen-normalized variant).
  assert.throws(
    () => assembleGh({ authInjection, headers: { 'X-Custom-Key': 'sneaky' } }),
    (e) => e.status === 400 && /may not set/.test(e.message),
  );
  assert.throws(
    () => assembleGh({ authInjection, headers: { x_custom_key: 'sneaky' } }),
    (e) => e.status === 400 && /may not set/.test(e.message),
  );
});

test('P2 assemble: legit non-auth headers pass through (Accept / Content-Type / X-GitHub-Api-Version / Idempotency-Key)', () => {
  const req = assembleGh({
    headers: {
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Idempotency-Key': 'abc-123',
      'User-Agent': 'zylos',
    },
  });
  assert.equal(req.headers.Accept, 'application/vnd.github+json');
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.equal(req.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(req.headers['Idempotency-Key'], 'abc-123');
  assert.equal(req.headers['User-Agent'], 'zylos');
});
