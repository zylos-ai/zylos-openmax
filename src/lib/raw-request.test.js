import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  hostFromUrlTemplate,
  allowedHostsFromCatalog,
  originFromUrlTemplate,
  allowedOriginsFromCatalog,
  originKey,
  parseRequestTarget,
  isDisallowedHost,
  isDisallowedAddress,
  resolveAndPin,
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

// A fixed "now" and a fresh catalog timestamp so the freshness fail-closed gate
// (P2) passes in the happy-path tests without touching the clock.
const NOW = 1_700_000_000_000;
const FRESH = NOW - 1000; // 1s old → fresh
const nowFn = () => NOW;

// A resolver double: returns public global-unicast addresses so resolveAndPin
// passes. Records how many times it was called (rebind/pinning assertions). NO
// real DNS is ever touched in these unit tests.
function fakeResolve(addresses) {
  const state = { calls: 0 };
  const queue = Array.isArray(addresses) ? [...addresses] : [addresses];
  const resolve = async () => {
    state.calls += 1;
    const a = queue.length > 1 ? queue.shift() : queue[0];
    return (Array.isArray(a) ? a : [a]).map((x) => (typeof x === 'string' ? { address: x, family: x.includes(':') ? 6 : 4 } : x));
  };
  return { resolve, state };
}
const publicResolve = () => fakeResolve('142.250.72.14').resolve; // a Google public IP

// A send-transport double recording the pinned IP handed to it (proves the
// connection targets the pre-validated address, not a re-resolved one).
function captureSend(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const sendImpl = async (assembled, opts) => {
    calls.push({ assembled, pin: opts && opts.pin });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    return { status_code: r.status ?? 200, headers: r.headers || {}, body: r.body ?? {} };
  };
  return { sendImpl, calls };
}

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
  assert.deepEqual(parseRequestTarget('gmail.googleapis.com'), { hostname: 'gmail.googleapis.com', port: 443, authority: 'gmail.googleapis.com' });
  assert.deepEqual(parseRequestTarget('api.example.com:8443'), { hostname: 'api.example.com', port: 8443, authority: 'api.example.com:8443' });
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
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/gmail/v1/users/me/labels', method: 'GET' },
    { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
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
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'evil.example.com', path: '/steal', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /not in this connection's allowed origin set/);
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
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'oauth2.googleapis.com', path: '/token', method: 'POST' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    /not in this connection's allowed origin set/,
  );
  assert.equal(calls.length, 0);
});

// P1.1 — PORT is part of the origin: an allowed host on an off-catalog port is
// rejected (the token is never attached or sent), even though the host matches.
test('requestDirect: PORT mismatch — allowed host on :8443 (catalog warrants :443) is rejected, token never sent', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com:8443', path: '/x', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /allowed origin set/);
      assert.match(err.message, /gmail\.googleapis\.com:8443/);
      return true;
    },
  );
  assert.equal(calls.length, 0, 'no network egress on a port mismatch');
});

// P1.1 (positive) — an explicit :443 on an allowed host IS accepted (443 is the
// origin default), proving the port gate is exact, not a blanket port ban.
test('requestDirect: explicit :443 on an allowed host is accepted', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com:443', path: '/x', method: 'GET' },
    { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
  );
  assert.equal(res.status_code, 200);
  assert.equal(calls.length, 1);
});

// P1.2 — a caller Host header is REJECTED (the CLI owns Host); token never sent.
test('requestDirect: caller Host header is REJECTED (routing-override), token never sent', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET', headers: { Host: 'evil.example' } },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 400); return /Host.*not allowed|not allowed.*Host/i.test(err.message); },
  );
  assert.equal(calls.length, 0, 'no network egress when a routing header is present');
});

test('requestDirect: HTTPS-only — a scheme in the domain is rejected as invalid, fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'http://gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
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
      { orgId: 'o', connection: { id: 'c1' }, catalog, catalogFetchedAt: FRESH, credential: CRED, domain: '169.254.169.254', path: '/latest/meta-data/', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 403); return /internal \/ metadata address/.test(err.message); },
  );
  assert.equal(calls.length, 0);
});

// P1.3 — an allowed host that RESOLVES to a private/CGNAT address is refused; the
// token is never attached or sent (DNS-level SSRF, not just hostname-string).
test('requestDirect: allowed host resolving to a private address is REJECTED, token never sent', async () => {
  const { sendImpl, calls } = captureSend({ status: 200, body: {} });
  const { resolve, state } = fakeResolve('10.0.0.5'); // public host name, private A record
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { sendImpl, resolve, now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 403); return /blocked internal \/ private address/.test(err.message); },
  );
  assert.equal(calls.length, 0, 'the transport is never reached — token never sent');
  assert.equal(state.calls, 1);
});

// P1.3 — if ANY resolved address is private, the whole request is refused (a
// public+private multi-answer must not slip through on the public one).
test('requestDirect: rejects when ONE of several resolved addresses is private', async () => {
  const { sendImpl, calls } = captureSend({ status: 200, body: {} });
  const { resolve } = fakeResolve([['142.250.72.14', '10.0.0.5']]);
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { sendImpl, resolve, now: nowFn, audit: quietAudit },
    ),
    /blocked internal \/ private address/,
  );
  assert.equal(calls.length, 0);
});

// P1.3 — DNS-rebind is defeated by PINNING: the address validated is the one
// connected to. The resolver is consulted EXACTLY ONCE and the transport receives
// that pinned public IP — there is no second, unvalidated lookup to swing the
// token onto a private address after validation.
test('requestDirect: pins the validated public IP for the connection (rebind-proof, single resolve)', async () => {
  const { sendImpl, calls } = captureSend({ status: 200, body: { ok: true } });
  // Resolver would flip to a private address on a hypothetical 2nd call; pinning
  // means there is no 2nd call.
  const { resolve, state } = fakeResolve([['142.250.72.14'], ['10.0.0.5']]);
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
    { sendImpl, resolve, now: nowFn, audit: quietAudit },
  );
  assert.equal(res.status_code, 200);
  assert.equal(state.calls, 1, 'resolver consulted exactly once — no TOCTOU second lookup');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pin.pinnedIp, '142.250.72.14', 'connection pinned to the validated public IP');
});

test('requestDirect: empty catalog → no derivable allowlist → 422, fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: [], catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 422); return true; },
  );
  assert.equal(calls.length, 0);
});

// P2 — freshness FAIL-CLOSED: a missing/absent catalogFetchedAt refuses the
// request (never authorizes off an eternal/stale cache), fetch never called.
test('requestDirect: missing catalogFetchedAt → refused fail-closed (409), fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 409); return /missing or stale.*fail-closed|fail-closed/i.test(err.message); },
  );
  assert.equal(calls.length, 0);
});

// P2 — a catalog older than the freshness window is likewise refused fail-closed.
test('requestDirect: stale catalogFetchedAt (beyond window) → refused fail-closed (409)', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  const stale = NOW - (25 * 60 * 60 * 1000); // 25h old > 24h window
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: stale, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 409); return true; },
  );
  assert.equal(calls.length, 0);
});

test('requestDirect: a caller Authorization header is ignored — only the CLI token goes out', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET', headers: { Authorization: 'Bearer ATTACKER' } },
    { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
  );
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer SECRET-TOKEN');
});

test('requestDirect: provider 401 triggers a single reactive refresh + retry (OAuth)', async () => {
  const { impl, calls } = fakeFetch([{ status: 401, body: {} }, { status: 200, body: { ok: true } }]);
  let acquired = 0;
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
    { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit, acquire: async () => { acquired += 1; return { access_token: 'FRESH-TOK', token_type: 'bearer' }; }, saveCache: () => {} },
  );
  assert.equal(acquired, 1);
  assert.equal(res.status_code, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer FRESH-TOK');
});

test('requestDirect: missing local token → 409 (direct-only, no downgrade), fetch never called', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: null, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 409); return true; },
  );
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
//  New pure-function coverage for the origin/port + resolved-IP boundaries
// ---------------------------------------------------------------------------

test('originFromUrlTemplate / allowedOriginsFromCatalog: preserve port, default 443', () => {
  assert.deepEqual(originFromUrlTemplate('https://api.example.com/x'), { host: 'api.example.com', port: 443 });
  assert.deepEqual(originFromUrlTemplate('https://api.example.com:8443/x'), { host: 'api.example.com', port: 8443 });
  assert.equal(originFromUrlTemplate('{base_url}/x'), null);
  assert.equal(originFromUrlTemplate('http://api.example.com/x'), null);
  const set = allowedOriginsFromCatalog(GMAIL_CATALOG);
  assert.equal(set.has('gmail.googleapis.com:443'), true);
  assert.equal(set.has('www.googleapis.com:443'), true);
  assert.equal(set.has('gmail.googleapis.com:8443'), false);
  assert.equal(originKey('API.Example.COM.', 443), 'api.example.com:443');
});

test('isDisallowedAddress: blocks private/CGNAT/loopback/link-local/ULA/mapped; allows public; fail-closed on garbage', () => {
  for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', 'ff02::1', '::ffff:10.0.0.1', 'not-an-ip']) {
    assert.equal(isDisallowedAddress(bad), true, `${bad} should be disallowed`);
  }
  for (const ok of ['142.250.72.14', '8.8.8.8', '2607:f8b0:4004:800::200e']) {
    assert.equal(isDisallowedAddress(ok), false, `${ok} should be allowed`);
  }
});

test('resolveAndPin: pins the first validated address; throws 403 when any is private', async () => {
  const pin = await resolveAndPin('h', async () => [{ address: '142.250.72.14', family: 4 }]);
  assert.equal(pin.pinnedIp, '142.250.72.14');
  assert.equal(pin.family, 4);
  await assert.rejects(() => resolveAndPin('h', async () => [{ address: '10.0.0.1', family: 4 }]), (e) => e.status === 403);
  await assert.rejects(() => resolveAndPin('h', async () => []), (e) => e.status === 502);
});

// P2 (updated per peer-review #12 fix-3 blocker #3b) — the audit line carries
// method + validated HOST + a STATIC REDACTED marker ONLY; the caller path,
// query, fragment, and any secret are NEVER logged (even a "canonicalized"
// pathname is caller-controlled and could carry a secret before a delimiter).
test('auditRawCall (via requestDirect): logs method + host + REDACTED path only — no caller path/query/secret', async () => {
  const { impl } = fakeFetch({ status: 200, body: {} });
  const lines = [];
  await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/gmail/v1/messages', method: 'GET', query: { api_key: 'CALLER-SECRET', x: 1 } },
    { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: (l) => lines.push(l) },
  );
  assert.equal(lines.length, 1);
  assert.equal(lines[0], '[conn.request] → GET https://gmail.googleapis.com/<path redacted>');
  assert.ok(!lines[0].includes('/gmail/v1/messages'), 'caller pathname never reaches the audit log');
  assert.ok(!lines[0].includes('CALLER-SECRET'), 'query secret never reaches the audit log');
  assert.ok(!lines[0].includes('SECRET-TOKEN'), 'token never reaches the audit log');
});

// P2 — a "?" (or "#") in `path` is rejected: query params MUST use the `query`
// field, so a caller secret cannot ride in via the path (and thus into a log).
test('requestDirect: path containing "?secret=..." is REJECTED (400), nothing sent', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: GMAIL_CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/v1/items?api_key=CALLER-SECRET&x=1', method: 'GET' },
      { fetchImpl: impl, resolve: publicResolve(), now: nowFn, audit: quietAudit },
    ),
    (err) => { assert.equal(err.status, 400); return /must not contain "\?" or "#"/.test(err.message); },
  );
  assert.equal(calls.length, 0);
});

test('assembleRawRequest: a caller Host / :authority header is dropped (defense-in-depth)', () => {
  const req = assembleRawRequest(
    { authority: 'api.example.com', path: '/x', method: 'GET', headers: { Host: 'evil.example', ':authority': 'evil.example', 'X-Ok': '1' } },
    'TOK', 'bearer',
  );
  assert.equal('Host' in req.headers, false);
  assert.equal(':authority' in req.headers, false);
  assert.equal(req.headers['X-Ok'], '1');
});
