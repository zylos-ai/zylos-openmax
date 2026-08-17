import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hostFromUrlTemplate,
  allowedHostsFromCatalog,
  parseRequestTarget,
  isDisallowedHost,
  assembleRawRequest,
  sendRawDirect,
  requestDirect,
} from './direct-exec.js';

// conn.request (Task #12) — raw / fully-custom direct request. These exercise the
// domain-allowlist gate (union of action-catalog url_template hosts, EXACT host
// match), the CLI-owned non-overridable Authorization, HTTPS-only, no
// cross-domain redirect follow, the SSRF block, and the RED LINE: on a gate
// failure the token is NEVER attached and NEVER sent.

const quietAudit = () => {};

// A fetch double recording every call so "token never sent" is assertable.
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

// A gmail-shaped catalog: two actions on gmail.googleapis.com, one on
// www.googleapis.com, plus a self-hosted "{base_url}" template that must NOT
// contribute a host.
const GMAIL_CATALOG = [
  { toolkit: 'gmail-messages', action: 'get', method: 'GET', url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}' },
  { toolkit: 'gmail-messages', action: 'send', method: 'POST', url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send' },
  { toolkit: 'gmail-files', action: 'upload', method: 'POST', url_template: 'https://www.googleapis.com/upload/gmail/v1/users/me/messages' },
  { toolkit: 'self-hosted', action: 'ping', method: 'GET', url_template: '{base_url}/ping' },
];

const CRED = { access_token: 'SECRET-TOKEN', token_type: 'bearer', credential_mode: 'direct' };

// ---------------------------------------------------------------------------
//  Host extraction + allowlist derivation
// ---------------------------------------------------------------------------

test('hostFromUrlTemplate: extracts host, strips port/userinfo, skips placeholder/non-https hosts', () => {
  assert.equal(hostFromUrlTemplate('https://gmail.googleapis.com/x/{id}'), 'gmail.googleapis.com');
  assert.equal(hostFromUrlTemplate('https://user:pw@api.example.com:8443/x'), 'api.example.com');
  assert.equal(hostFromUrlTemplate('https://API.Example.COM./x'), 'api.example.com');
  assert.equal(hostFromUrlTemplate('{base_url}/ping'), null);         // placeholder host
  assert.equal(hostFromUrlTemplate('https://{host}/x'), null);        // placeholder host
  assert.equal(hostFromUrlTemplate('http://plain.example.com/x'), null); // non-https
  assert.equal(hostFromUrlTemplate(''), null);
});

test('allowedHostsFromCatalog: UNION of url_template hosts; placeholder host excluded', () => {
  const set = allowedHostsFromCatalog(GMAIL_CATALOG);
  assert.deepEqual([...set].sort(), ['gmail.googleapis.com', 'www.googleapis.com']);
  assert.equal(set.has('googleapis.com'), false); // no bare-parent widening
});

test('parseRequestTarget: accepts a bare host (+port); rejects scheme/path/userinfo/space', () => {
  assert.deepEqual(parseRequestTarget('gmail.googleapis.com'), { hostname: 'gmail.googleapis.com', authority: 'gmail.googleapis.com' });
  assert.deepEqual(parseRequestTarget('api.example.com:8443'), { hostname: 'api.example.com', authority: 'api.example.com:8443' });
  assert.equal(parseRequestTarget('https://gmail.googleapis.com'), null);
  assert.equal(parseRequestTarget('gmail.googleapis.com/path'), null);
  assert.equal(parseRequestTarget('evil.com@good.com'), null);
  assert.equal(parseRequestTarget('good.com /x'), null);
  assert.equal(parseRequestTarget(''), null);
});

test('isDisallowedHost: blocks loopback/private/link-local/metadata/localhost, allows public', () => {
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.5.5', '192.168.0.1', '169.254.169.254', '0.0.0.0', 'localhost', 'svc.internal', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isDisallowedHost(bad), true, `${bad} should be blocked`);
  }
  for (const ok of ['gmail.googleapis.com', '8.8.8.8', 'api.github.com']) {
    assert.equal(isDisallowedHost(ok), false, `${ok} should be allowed`);
  }
});

// ---------------------------------------------------------------------------
//  Request assembly — HTTPS-only, CLI-owned Authorization, body handling
// ---------------------------------------------------------------------------

test('assembleRawRequest: builds https URL with path+query, injects Bearer, no body on GET', () => {
  const req = assembleRawRequest(
    { authority: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'GET', query: { pageToken: 'abc def', max: 5 } },
    'TOK', 'bearer',
  );
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/labels?pageToken=abc%20def&max=5');
  assert.equal(req.headers.Authorization, 'Bearer TOK');
  assert.equal(req.body, undefined);
});

test('assembleRawRequest: caller CANNOT override the CLI-owned Authorization header (any case)', () => {
  const req = assembleRawRequest(
    { authority: 'gmail.googleapis.com', path: '/x', method: 'GET', headers: { authorization: 'Bearer ATTACKER', 'X-Foo': 'bar' } },
    'TOK', 'bearer',
  );
  // Exactly one Authorization-ish header, and it is the CLI's.
  const authKeys = Object.keys(req.headers).filter((k) => k.toLowerCase() === 'authorization');
  assert.deepEqual(authKeys, ['Authorization']);
  assert.equal(req.headers.Authorization, 'Bearer TOK');
  assert.equal(req.headers['X-Foo'], 'bar'); // other caller headers survive
});

test('assembleRawRequest: object body → JSON + Content-Type; string body sent verbatim', () => {
  const j = assembleRawRequest({ authority: 'api.example.com', path: '/x', method: 'POST', body: { a: 1 } }, 'TOK');
  assert.equal(j.body, '{"a":1}');
  assert.equal(j.headers['Content-Type'], 'application/json');
  const s = assembleRawRequest({ authority: 'api.example.com', path: '/x', method: 'POST', body: 'raw-bytes' }, 'TOK');
  assert.equal(s.body, 'raw-bytes');
  assert.equal(s.headers['Content-Type'], undefined);
});

test('assembleRawRequest: rejects an unsupported method', () => {
  assert.throws(() => assembleRawRequest({ authority: 'api.example.com', path: '/x', method: 'CONNECT' }, 'TOK'), /unsupported HTTP method/);
});

// ---------------------------------------------------------------------------
//  send — no cross-domain redirect follow; body not re-encoded
// ---------------------------------------------------------------------------

test('sendRawDirect: passes redirect:manual and sends the pre-serialized body verbatim', async () => {
  const { impl, calls } = fakeFetch({ status: 302, headers: { location: 'https://evil.example.com/' }, body: '' });
  const res = await sendRawDirect({ method: 'POST', url: 'https://api.example.com/x', headers: { Authorization: 'Bearer T' }, body: 'raw-bytes' }, { fetchImpl: impl });
  assert.equal(calls[0].opts.redirect, 'manual');
  assert.equal(calls[0].opts.body, 'raw-bytes'); // NOT JSON.stringify'd again
  assert.equal(res.status_code, 302);            // 3xx returned as-is, not followed
});

// ---------------------------------------------------------------------------
//  requestDirect — the allowlist GATE (the core security control)
// ---------------------------------------------------------------------------

test('requestDirect: ACCEPTS an in-allowlist domain and attaches the token', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { labels: [] } });
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'GET' },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(res.status_code, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer SECRET-TOKEN');
});

test('requestDirect: REJECTS an off-allowlist domain — token NEVER attached, fetch NEVER called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'evil.example.com', path: '/steal', method: 'GET' },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /not in this connection's allowed host set/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'fetch must never be called on a rejected domain');
});

test('requestDirect: EXACT host match — a sibling subdomain not in the catalog is rejected', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  // oauth2.googleapis.com is a real Google host but is NOT in this catalog.
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'oauth2.googleapis.com', path: '/token', method: 'POST' },
      { fetchImpl: impl, audit: quietAudit },
    ),
    /not in this connection's allowed host set/,
  );
  assert.equal(calls.length, 0);
});

test('requestDirect: HTTPS-only — a scheme in the domain is rejected as invalid, fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'http://gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 400); return /invalid domain/.test(err.message); },
  );
  assert.equal(calls.length, 0);
});

test('requestDirect: internal/metadata IP is blocked even if it were in the catalog', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  const catalog = [{ toolkit: 't', action: 'a', method: 'GET', url_template: 'https://169.254.169.254/latest/meta-data/' }];
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog, credential: CRED, domain: '169.254.169.254', path: '/latest/meta-data/', method: 'GET' },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 403); return /internal \/ metadata address/.test(err.message); },
  );
  assert.equal(calls.length, 0);
});

test('requestDirect: empty catalog → no derivable allowlist → 422, fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: [], credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 422); return true; },
  );
  assert.equal(calls.length, 0);
});

test('requestDirect: a caller Authorization header is ignored — only the CLI token goes out', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET', headers: { Authorization: 'Bearer ATTACKER' } },
    { fetchImpl: impl, audit: quietAudit },
  );
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer SECRET-TOKEN');
});

test('requestDirect: provider 401 triggers a single reactive refresh + retry (OAuth)', async () => {
  const { impl, calls } = fakeFetch([{ status: 401, body: {} }, { status: 200, body: { ok: true } }]);
  let acquired = 0;
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
    { fetchImpl: impl, audit: quietAudit, acquire: async () => { acquired += 1; return { access_token: 'FRESH', token_type: 'bearer' }; }, saveCache: () => {} },
  );
  assert.equal(acquired, 1);
  assert.equal(res.status_code, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer FRESH');
});

test('requestDirect: missing local token → 409 (direct-only, no downgrade), fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: null, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 409); return true; },
  );
  assert.equal(calls.length, 0);
});
