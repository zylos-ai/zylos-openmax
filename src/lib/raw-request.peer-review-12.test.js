import assert from 'node:assert/strict';
import { test } from 'node:test';
import https from 'node:https';

import {
  pinnedLookup,
  sendPinnedHttps,
  isDisallowedAddress,
  isDisallowedHost,
  assembleRawRequest,
  requestDirect,
  CATALOG_CLOCK_SKEW_MS,
} from './direct-exec.js';
import { isCatalogFresh } from './connect-store.js';

// ===========================================================================
//  Peer-review NEEDS-FIX #2 regressions (auto-task #12, PR #129). Each block is
//  tied to a reviewer blocker. UNIT/loopback only — no live network or DNS.
// ===========================================================================

const quietAudit = () => {};
const NOW = 1_700_000_000_000;
const nowFn = () => NOW;
const FRESH = NOW - 1000;
const CATALOG = [
  { toolkit: 'gmail', action: 'get', method: 'GET', url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}' },
];
const CRED = { access_token: 'SECRET-TOKEN', token_type: 'bearer', credential_mode: 'direct' };
const publicResolve = () => async () => [{ address: '142.250.72.14', family: 4 }];

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
//  [P1] #1 — pinned HTTPS transport must handle BOTH lookup callback shapes and
//  actually work end-to-end against a real (loopback) TLS server.
// ---------------------------------------------------------------------------

test('#1 pinnedLookup: {all:true} returns an ARRAY [{address,family}] (the shape Node v20+ requires)', () => {
  const lookup = pinnedLookup({ pinnedIp: '203.0.113.7', family: 4 });
  let got;
  lookup('api.example.com', { all: true }, (err, res) => { got = { err, res }; });
  assert.equal(got.err, null);
  assert.deepEqual(got.res, [{ address: '203.0.113.7', family: 4 }]);
});

test('#1 pinnedLookup: scalar call returns (err, address, family)', () => {
  const lookup = pinnedLookup({ pinnedIp: '203.0.113.7', family: 4 });
  let got;
  lookup('api.example.com', {}, (err, address, family) => { got = { err, address, family }; });
  assert.equal(got.err, null);
  assert.equal(got.address, '203.0.113.7');
  assert.equal(got.family, 4);
});

test('#1 pinnedLookup: 2-arg lookup(hostname, cb) form is handled', () => {
  const lookup = pinnedLookup({ pinnedIp: '::1', family: 6 });
  let got;
  lookup('api.example.com', (err, address, family) => { got = { err, address, family }; });
  assert.equal(got.err, null);
  assert.equal(got.address, '::1');
  assert.equal(got.family, 6);
});

// Embedded self-signed cert for CN/SAN=api.provider.example so the test is
// hermetic (no openssl at test time). Long-lived (year 2126).
const TLS_CERT = "-----BEGIN CERTIFICATE-----\nMIIDQjCCAiqgAwIBAgIUCiMMd2lqaFXh+AfpjL9F4UNdLG4wDQYJKoZIhvcNAQEL\nBQAwHzEdMBsGA1UEAwwUYXBpLnByb3ZpZGVyLmV4YW1wbGUwIBcNMjYwODE3MTgy\nODEwWhgPMjEyNjA3MjQxODI4MTBaMB8xHTAbBgNVBAMMFGFwaS5wcm92aWRlci5l\neGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Ba6h5QRcXdn\nBacBK1H1JLjCaOFmYmOaO5ORK+raCnffpvEJYvWuAL4rGnaBSTfbv850gx5DFIrP\noLY9aHas/Mrr0oYc/Th09Uf4cbXJbFvLe6OMGdgSzWxJKJR/MNsPl+VbK0cuakpO\nU6dlQJc79fz19tEKEdBF7FlpDYwOWxF6OYJOpKbFl9ET6/3e/n1xLhNUuOgN8a8Y\ncnVFJR1t5FKpnT6JlxO1M4OnR/CwlflPN3n2KjD8FSRP9TjHMk3ZZ51skzNvRaaE\ncr6QJ4OD4Xsye2w7IVXfstsVbmLZVttdhsKBIKtK+BY64dxAnEhBW/qp9HMTo8Ww\nSsIgaBjhQQIDAQABo3QwcjAdBgNVHQ4EFgQUs5t0u3+ld/9fKzY7pQ1tK4RuJKIw\nHwYDVR0jBBgwFoAUs5t0u3+ld/9fKzY7pQ1tK4RuJKIwDwYDVR0TAQH/BAUwAwEB\n/zAfBgNVHREEGDAWghRhcGkucHJvdmlkZXIuZXhhbXBsZTANBgkqhkiG9w0BAQsF\nAAOCAQEAnU0DdHGXh8fczy9RDnOB77Kb9UiN5gQDTjtxXOtsmoCzmFXU2nM/yRpq\nWtOYYFL+9E9zUh6qDNfNEBYbhPxFuKS3IcVG4BkdXpRr9qw1g2aAlAX2MsLK1Wnj\npUviqY1AmzWiPRa6GOZ99SiOjlk+HY9idF9Hg5Uk5c4FUo65L51sM1WDOpKP0Mpy\n6JQMov8JfyeT2RNpTMFRiW6vU91dJKaWxCfyYO7Z8EmYWb6TZUqtMHgpIeT37fZD\nN6Wi73VEi9Z2kokN3D4zqYnrvm1hgQZVNDAZ6A6IrckKOOwjlLM4MfV4WyRDRTWt\nxX6EjubadiTKrXeYDNS3Mjl08Myu4w==\n-----END CERTIFICATE-----\n";
const TLS_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQFrqHlBFxd2cF\npwErUfUkuMJo4WZiY5o7k5Er6toKd9+m8Qli9a4AvisadoFJN9u/znSDHkMUis+g\ntj1odqz8yuvShhz9OHT1R/hxtclsW8t7o4wZ2BLNbEkolH8w2w+X5VsrRy5qSk5T\np2VAlzv1/PX20QoR0EXsWWkNjA5bEXo5gk6kpsWX0RPr/d7+fXEuE1S46A3xrxhy\ndUUlHW3kUqmdPomXE7Uzg6dH8LCV+U83efYqMPwVJE/1OMcyTdlnnWyTM29FpoRy\nvpAng4PhezJ7bDshVd+y2xVuYtlW212GwoEgq0r4Fjrh3ECcSEFb+qn0cxOjxbBK\nwiBoGOFBAgMBAAECggEAAKdIBKvGKXLavV2asLxVwCMrl4RSe8kDFfoCDbJAgKHp\nvBUSFqzdoND4D66cyOvgLvtpMEEErIIKSHkdOw1ZJurenLWhGuAPgsNFsdqEfGhs\nlig1Hp7bSEJCMVqhOThAfBVs5ap+jp59hBO75KnU6ivWL37U89z3xNgIojgOkq8I\nHe9esRIBkOTL3HH1xcL3n1+Nkm1E94Y6GuTD8y8Ln4MD/Tus+UmcZFjquH8zyYWS\nXgUKYcgIbb6e+4B+PzNyQVNmG9v8rIPxFeDLa8xgiEUGyexM8D3pmllPIVogAj0k\ngpCXnNxIyw+qW81XxR5p58I1UgJHP+AJOfUVHEuWxQKBgQDm2+7/OKsri2BNGoxa\n5AashEN1kzZ16HLBT6Whyny2V0I9X2DWX+GfEtLHRaQ/5ZrTRaX2/nHGAhJJBbMQ\nqxs3bsKaO+PoSfjJ7h7Ccf7n4NCmClqhNdt5sqsHxWltL9rDWV+uZeUc7FbFdHjY\nqkCXxy7TMCfHTEqWKwbXNKMk9wKBgQDmv/yDXi2P+RUH8sEa9vZqLfKFXGAACT5L\nSwbQcoRY0S7l1kppH5SBp6VYpxcYdvNlUNq2P+FIQ4WN34GMHhgxDu3vYGWA4ogp\nM+sP5QnLthT0vtPTdfz0enNgLkEfEulHshwyMpFe4CMya4VGiBFVxml4dK88ueS1\nn3jGndD1hwKBgQDBotPyKtwX6A3cXlo/mmemqEHVCqdxeolWb7Hj5O16G/Kpe6jD\n5yRdwvIcxuMf3Txh3Vd5tq5DgVVI/ojVgE+RzUtZBscA/Zq59QrD2c4PPFiGDMU7\n1urCRwSBvinRtYPuurYwl7L28Z1OfYUnZpZLOHykEw4qcmlVT72rILF+vQKBgQC+\nzTuQqNxF83Gne9yfXlyNmeayzZp4DSycd7JvxHGZO4dq91HaMQnMWAKKFsgrK5jB\nSyU+k/3Fkkep84mcgfoA/tZSHMRx2V87qrmREBOUhcA4TF69uQ9sXKBwhG7Gsg2B\ngk58V4ILEI0qEOxIURT8dy8ZMmsAbLooUHA+05pImwKBgC2nYucV8GDcnjaZVzzp\nwaNNa6ihWnkOAQJBYTGZsAKIoVmbePA3mYTTkp4iNMUtnpNhIQpQYX1IhRcLmVav\nT6aqSU/SOHhqjPVJIWamNO9LLaPi/70LoMCqIn9dAXnqkDiwsLN9ERLxXkdoJyGI\nrFvzr3Rx0RTSJVv1vtNqqTM6\n-----END PRIVATE KEY-----\n";

test('#1 sendPinnedHttps: REAL loopback TLS server — pinned IP used, SNI+Host=real host, CLI-owned Authorization', async () => {
  const seen = { servername: null, host: null, authorization: null, method: null, path: null };
  const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
    seen.servername = req.socket.servername;
    seen.host = req.headers.host;
    seen.authorization = req.headers.authorization;
    seen.method = req.method;
    seen.path = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    // The URL host is the REAL provider hostname (never 127.0.0.1). If the pinned
    // lookup were NOT honoured, Node would try to resolve api.provider.example and
    // fail (NXDOMAIN) — so a successful response PROVES the pinned 127.0.0.1 was
    // dialled while SNI/Host stayed the real host.
    const assembled = assembleRawRequest(
      { authority: `api.provider.example:${port}`, path: '/v1/thing', method: 'GET' },
      'PROVIDER-TOKEN', 'bearer',
    );
    const res = await sendPinnedHttps(
      assembled,
      { pinnedIp: '127.0.0.1', family: 4 },
      { ca: TLS_CERT, rejectUnauthorized: true },
    );
    assert.equal(res.status_code, 200);
    assert.deepEqual(res.body, { ok: true });
    assert.equal(seen.servername, 'api.provider.example', 'SNI must be the real hostname');
    assert.equal(seen.host, `api.provider.example:${port}`, 'Host header must be the CLI-owned real host');
    assert.equal(seen.authorization, 'Bearer PROVIDER-TOKEN', 'Authorization must be CLI-owned');
    assert.equal(seen.method, 'GET');
    assert.equal(seen.path, '/v1/thing');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---------------------------------------------------------------------------
//  [P1] #2 — IPv6 private/link-local/mapped encodings must NOT bypass the
//  all-address public check. Each is a vector zylos0t listed.
// ---------------------------------------------------------------------------

test('#2 isDisallowedAddress: link-local fe80::/10 across the whole range (fe90/fea0/febf), not just fe80', () => {
  for (const bad of ['fe80::1', 'fe90::1', 'fea0::1', 'febf::1', 'febf:ffff::1']) {
    assert.equal(isDisallowedAddress(bad), true, `${bad} (fe80::/10) must be blocked`);
  }
  // fec0:: is site-local (deprecated) and NOT inside fe80::/10 → not link-local;
  // 2001:db8:: is documentation but classified as global unicast here.
  assert.equal(isDisallowedAddress('2607:f8b0:4004:800::200e'), false);
});

test('#2 isDisallowedAddress: v4-mapped private in HEX form (::ffff:a00:1) is blocked like dotted', () => {
  assert.equal(isDisallowedAddress('::ffff:a00:1'), true, '::ffff:10.0.0.1 in hex');
  assert.equal(isDisallowedAddress('::ffff:10.0.0.1'), true, 'dotted form');
  assert.equal(isDisallowedAddress('::ffff:7f00:1'), true, '::ffff:127.0.0.1 loopback in hex');
  assert.equal(isDisallowedAddress('::ffff:6440:1'), true, '::ffff:100.64.0.1 CGNAT in hex');
  assert.equal(isDisallowedAddress('::ffff:0808:0808'), false, '::ffff:8.8.8.8 public → allowed');
});

test('#2 isDisallowedAddress: expanded loopback / unspecified / v4-compatible forms are blocked', () => {
  for (const bad of ['0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::1', '::', '::0.0.0.0', '::10.0.0.1', '::127.0.0.1']) {
    assert.equal(isDisallowedAddress(bad), true, `${bad} must be blocked`);
  }
});

test('#2 isDisallowedAddress: ULA fc00::/7 and multicast ff00::/8 blocked; garbage fails closed', () => {
  for (const bad of ['fc00::1', 'fd12:3456::1', 'ff02::1', 'ff05::1:3', 'not-an-ip', 'fe80::1::2']) {
    assert.equal(isDisallowedAddress(bad), true, `${bad} must be blocked / fail closed`);
  }
});

test('#2 isDisallowedHost: literal IPv6 bypass encodings are blocked on the host string too', () => {
  for (const bad of ['fe90::1', '[fea0::1]', '::ffff:a00:1', '[::ffff:127.0.0.1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(isDisallowedHost(bad), true, `${bad} must be blocked as a host literal`);
  }
  assert.equal(isDisallowedHost('gmail.googleapis.com'), false);
  assert.equal(isDisallowedHost('2607:f8b0:4004:800::200e'), false);
});

// ---------------------------------------------------------------------------
//  [P2] #3 — a FUTURE fetchedAt must NOT authorize forever.
// ---------------------------------------------------------------------------

test('#3 isCatalogFresh: a future fetchedAt (beyond skew) is STALE, not eternally fresh', () => {
  const rec = { actions: [], fetchedAt: NOW + 365 * 24 * 60 * 60 * 1000 }; // +1yr
  assert.equal(isCatalogFresh(rec, { ttlMs: 24 * 60 * 60 * 1000, now: NOW }), false);
  // Small within-skew clock drift is still tolerated.
  assert.equal(isCatalogFresh({ actions: [], fetchedAt: NOW + 1000 }, { ttlMs: 24 * 60 * 60 * 1000, now: NOW }), true);
  // A normal recent record is fresh.
  assert.equal(isCatalogFresh({ actions: [], fetchedAt: NOW - 1000 }, { ttlMs: 24 * 60 * 60 * 1000, now: NOW }), true);
});

test('#3 requestDirect: future catalogFetchedAt → refused fail-closed (409), token never resolved', async () => {
  const { sendImpl, calls } = captureSend({ status: 200 });
  let credResolved = 0;
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: NOW + 365 * 24 * 60 * 60 * 1000, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { sendImpl, resolve: publicResolve(), now: nowFn, audit: quietAudit, getCredential: async () => { credResolved += 1; return CRED; } },
    ),
    (err) => { assert.equal(err.status, 409); return /future timestamp|stale|fail-closed/i.test(err.message); },
  );
  assert.equal(calls.length, 0, 'nothing sent');
  assert.equal(credResolved, 0, 'credential never resolved on a stale/forged catalog');
});

// ---------------------------------------------------------------------------
//  [P2] #4 — URL-encoded query-shaped secret must not enter the request/audit.
// ---------------------------------------------------------------------------

test('#4 assembleRawRequest: encoded %3F / %23 in path is REJECTED like literal ?/#', () => {
  for (const p of ['/v1/%3Fapi_key%3DSECRET', '/v1/%23frag', '/a%3fb', '/a%23b']) {
    assert.throws(
      () => assembleRawRequest({ authority: 'api.example.com', path: p, method: 'GET' }, 'T', 'bearer'),
      (err) => { assert.equal(err.status, 400); return /must not contain "\?" or "#"/.test(err.message); },
      `path ${p} must be rejected`,
    );
  }
});

test('#4 requestDirect: encoded query-shaped secret in path → 400, secret NEVER audited, nothing sent', async () => {
  const { sendImpl, calls } = captureSend({ status: 200 });
  const logged = [];
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/v1/%3Fapi_key%3DCALLER-SECRET', method: 'GET' },
      { sendImpl, resolve: publicResolve(), now: nowFn, audit: (l) => logged.push(l) },
    ),
    (err) => { assert.equal(err.status, 400); return true; },
  );
  assert.equal(calls.length, 0, 'nothing sent');
  assert.ok(!logged.some((l) => /CALLER-SECRET|api_key/i.test(l)), 'secret must never appear in the audit log');
});

// ---------------------------------------------------------------------------
//  [P2] #5 — credential resolution must run STRICTLY AFTER the structural gates.
// ---------------------------------------------------------------------------

test('#5 requestDirect: an OFF-ORIGIN request never triggers credential resolution', async () => {
  const { sendImpl, calls } = captureSend({ status: 200 });
  let credResolved = 0;
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'evil.example.com', path: '/steal', method: 'GET' },
      { sendImpl, resolve: publicResolve(), now: nowFn, audit: quietAudit, getCredential: async () => { credResolved += 1; return CRED; } },
    ),
    (err) => { assert.equal(err.status, 403); return true; },
  );
  assert.equal(credResolved, 0, 'credential must NOT be resolved on an off-origin request');
  assert.equal(calls.length, 0);
});

test('#5 requestDirect: a request resolving to a PRIVATE address never triggers credential resolution', async () => {
  const { sendImpl, calls } = captureSend({ status: 200 });
  let credResolved = 0;
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { sendImpl, resolve: async () => [{ address: '10.0.0.5', family: 4 }], now: nowFn, audit: quietAudit, getCredential: async () => { credResolved += 1; return CRED; } },
    ),
    (err) => { assert.equal(err.status, 403); return true; },
  );
  assert.equal(credResolved, 0, 'credential must NOT be resolved when DNS yields a private address');
  assert.equal(calls.length, 0);
});

test('#5 requestDirect: a LEGAL request DOES resolve the credential (lazily) and sends with the token', async () => {
  const { sendImpl, calls } = captureSend({ status: 200, body: { ok: true } });
  let credResolved = 0;
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
    { sendImpl, resolve: publicResolve(), now: nowFn, audit: quietAudit, getCredential: async () => { credResolved += 1; return CRED; } },
  );
  assert.equal(res.status_code, 200);
  assert.equal(credResolved, 1, 'credential resolved exactly once, AFTER gates passed');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].assembled.headers.Authorization, 'Bearer SECRET-TOKEN');
  assert.equal(calls[0].pin.pinnedIp, '142.250.72.14');
});

// Sanity: CATALOG_CLOCK_SKEW_MS is a small finite bound, not unbounded.
test('#3 CATALOG_CLOCK_SKEW_MS is a small finite skew (minutes, not unbounded)', () => {
  assert.ok(Number.isFinite(CATALOG_CLOCK_SKEW_MS) && CATALOG_CLOCK_SKEW_MS > 0 && CATALOG_CLOCK_SKEW_MS <= 60 * 60 * 1000);
});
