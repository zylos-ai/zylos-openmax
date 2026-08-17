import assert from 'node:assert/strict';
import { test } from 'node:test';
import https from 'node:https';

import {
  sendPinnedHttps,
  assembleRawRequest,
  assertPathHasNoDelimiter,
  assertRawMethodAllowed,
  isDisallowedAddress,
  isDisallowedHost,
  requestDirect,
} from './direct-exec.js';

// ===========================================================================
//  Peer-review NEEDS-FIX #3 regressions (auto-task #12, PR #129). Four deeper
//  security blockers from zylos0t. UNIT / loopback only — no live network/DNS.
//   #1 pin bypassed by the global HTTPS connection pool
//   #2 IPv6 site-local fec0::/10 still allowed (must be fail-closed global-only)
//   #3 double-/triple-encoded query-shaped secret still passes + audit leaks path
//   #4 credential getter runs before structural validation
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

// Embedded self-signed cert for CN/SAN=api.provider.example (year 2126). Same
// material as the round-2 suite — hermetic, no openssl at test time.
const TLS_CERT = "-----BEGIN CERTIFICATE-----\nMIIDQjCCAiqgAwIBAgIUCiMMd2lqaFXh+AfpjL9F4UNdLG4wDQYJKoZIhvcNAQEL\nBQAwHzEdMBsGA1UEAwwUYXBpLnByb3ZpZGVyLmV4YW1wbGUwIBcNMjYwODE3MTgy\nODEwWhgPMjEyNjA3MjQxODI4MTBaMB8xHTAbBgNVBAMMFGFwaS5wcm92aWRlci5l\neGFtcGxlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA0Ba6h5QRcXdn\nBacBK1H1JLjCaOFmYmOaO5ORK+raCnffpvEJYvWuAL4rGnaBSTfbv850gx5DFIrP\noLY9aHas/Mrr0oYc/Th09Uf4cbXJbFvLe6OMGdgSzWxJKJR/MNsPl+VbK0cuakpO\nU6dlQJc79fz19tEKEdBF7FlpDYwOWxF6OYJOpKbFl9ET6/3e/n1xLhNUuOgN8a8Y\ncnVFJR1t5FKpnT6JlxO1M4OnR/CwlflPN3n2KjD8FSRP9TjHMk3ZZ51skzNvRaaE\ncr6QJ4OD4Xsye2w7IVXfstsVbmLZVttdhsKBIKtK+BY64dxAnEhBW/qp9HMTo8Ww\nSsIgaBjhQQIDAQABo3QwcjAdBgNVHQ4EFgQUs5t0u3+ld/9fKzY7pQ1tK4RuJKIw\nHwYDVR0jBBgwFoAUs5t0u3+ld/9fKzY7pQ1tK4RuJKIwDwYDVR0TAQH/BAUwAwEB\n/zAfBgNVHREEGDAWghRhcGkucHJvdmlkZXIuZXhhbXBsZTANBgkqhkiG9w0BAQsF\nAAOCAQEAnU0DdHGXh8fczy9RDnOB77Kb9UiN5gQDTjtxXOtsmoCzmFXU2nM/yRpq\nWtOYYFL+9E9zUh6qDNfNEBYbhPxFuKS3IcVG4BkdXpRr9qw1g2aAlAX2MsLK1Wnj\npUviqY1AmzWiPRa6GOZ99SiOjlk+HY9idF9Hg5Uk5c4FUo65L51sM1WDOpKP0Mpy\n6JQMov8JfyeT2RNpTMFRiW6vU91dJKaWxCfyYO7Z8EmYWb6TZUqtMHgpIeT37fZD\nN6Wi73VEi9Z2kokN3D4zqYnrvm1hgQZVNDAZ6A6IrckKOOwjlLM4MfV4WyRDRTWt\nxX6EjubadiTKrXeYDNS3Mjl08Myu4w==\n-----END CERTIFICATE-----\n";
const TLS_KEY = "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDQFrqHlBFxd2cF\npwErUfUkuMJo4WZiY5o7k5Er6toKd9+m8Qli9a4AvisadoFJN9u/znSDHkMUis+g\ntj1odqz8yuvShhz9OHT1R/hxtclsW8t7o4wZ2BLNbEkolH8w2w+X5VsrRy5qSk5T\np2VAlzv1/PX20QoR0EXsWWkNjA5bEXo5gk6kpsWX0RPr/d7+fXEuE1S46A3xrxhy\ndUUlHW3kUqmdPomXE7Uzg6dH8LCV+U83efYqMPwVJE/1OMcyTdlnnWyTM29FpoRy\nvpAng4PhezJ7bDshVd+y2xVuYtlW212GwoEgq0r4Fjrh3ECcSEFb+qn0cxOjxbBK\nwiBoGOFBAgMBAAECggEAAKdIBKvGKXLavV2asLxVwCMrl4RSe8kDFfoCDbJAgKHp\nvBUSFqzdoND4D66cyOvgLvtpMEEErIIKSHkdOw1ZJurenLWhGuAPgsNFsdqEfGhs\nlig1Hp7bSEJCMVqhOThAfBVs5ap+jp59hBO75KnU6ivWL37U89z3xNgIojgOkq8I\nHe9esRIBkOTL3HH1xcL3n1+Nkm1E94Y6GuTD8y8Ln4MD/Tus+UmcZFjquH8zyYWS\nXgUKYcgIbb6e+4B+PzNyQVNmG9v8rIPxFeDLa8xgiEUGyexM8D3pmllPIVogAj0k\ngpCXnNxIyw+qW81XxR5p58I1UgJHP+AJOfUVHEuWxQKBgQDm2+7/OKsri2BNGoxa\n5AashEN1kzZ16HLBT6Whyny2V0I9X2DWX+GfEtLHRaQ/5ZrTRaX2/nHGAhJJBbMQ\nqxs3bsKaO+PoSfjJ7h7Ccf7n4NCmClqhNdt5sqsHxWltL9rDWV+uZeUc7FbFdHjY\nqkCXxy7TMCfHTEqWKwbXNKMk9wKBgQDmv/yDXi2P+RUH8sEa9vZqLfKFXGAACT5L\nSwbQcoRY0S7l1kppH5SBp6VYpxcYdvNlUNq2P+FIQ4WN34GMHhgxDu3vYGWA4ogp\nM+sP5QnLthT0vtPTdfz0enNgLkEfEulHshwyMpFe4CMya4VGiBFVxml4dK88ueS1\nn3jGndD1hwKBgQDBotPyKtwX6A3cXlo/mmemqEHVCqdxeolWb7Hj5O16G/Kpe6jD\n5yRdwvIcxuMf3Txh3Vd5tq5DgVVI/ojVgE+RzUtZBscA/Zq59QrD2c4PPFiGDMU7\n1urCRwSBvinRtYPuurYwl7L28Z1OfYUnZpZLOHykEw4qcmlVT72rILF+vQKBgQC+\nzTuQqNxF83Gne9yfXlyNmeayzZp4DSycd7JvxHGZO4dq91HaMQnMWAKKFsgrK5jB\nSyU+k/3Fkkep84mcgfoA/tZSHMRx2V87qrmREBOUhcA4TF69uQ9sXKBwhG7Gsg2B\ngk58V4ILEI0qEOxIURT8dy8ZMmsAbLooUHA+05pImwKBgC2nYucV8GDcnjaZVzzp\nwaNNa6ihWnkOAQJBYTGZsAKIoVmbePA3mYTTkp4iNMUtnpNhIQpQYX1IhRcLmVav\nT6aqSU/SOHhqjPVJIWamNO9LLaPi/70LoMCqIn9dAXnqkDiwsLN9ERLxXkdoJyGI\nrFvzr3Rx0RTSJVv1vtNqqTM6\n-----END PRIVATE KEY-----\n";

function tlsServer(onReq, ip, port) {
  const server = https.createServer({ cert: TLS_CERT, key: TLS_KEY }, (req, res) => {
    onReq(req);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ip }));
  });
  return new Promise((resolve) => server.listen(port, ip, () => resolve(server)));
}

// ---------------------------------------------------------------------------
//  [P1] #1 — pooling must be DISABLED: two consecutive requests to the SAME
//  authority (host:port) with a CHANGED pin must NOT reuse the first socket.
//  Two loopback TLS servers share one port on distinct loopback IPs
//  (127.0.0.1 / 127.0.0.2). With the global agent pooling by "host:port" the 2nd
//  request would reuse the 1st socket → its token would land on server #1. With
//  `agent:false` each call opens a fresh socket to its own pin.
// ---------------------------------------------------------------------------

test('#1 sendPinnedHttps: two consecutive calls, changed pin — 2nd honours the new pin, no socket reuse, no token cross-send', async () => {
  const seen1 = [];
  const seen2 = [];
  const s1 = await tlsServer((req) => seen1.push(req.headers.authorization), '127.0.0.1', 0);
  const port = s1.address().port;
  const s2 = await tlsServer((req) => seen2.push(req.headers.authorization), '127.0.0.2', port);
  try {
    const authority = `api.provider.example:${port}`;
    // Request 1 → pinned to 127.0.0.1, token ONE.
    const r1 = await sendPinnedHttps(
      assembleRawRequest({ authority, path: '/one', method: 'GET' }, 'ONE', 'bearer'),
      { pinnedIp: '127.0.0.1', family: 4 },
      { ca: TLS_CERT, rejectUnauthorized: true },
    );
    // Request 2 → SAME authority, pin CHANGED to 127.0.0.2, token TWO.
    const r2 = await sendPinnedHttps(
      assembleRawRequest({ authority, path: '/two', method: 'GET' }, 'TWO', 'bearer'),
      { pinnedIp: '127.0.0.2', family: 4 },
      { ca: TLS_CERT, rejectUnauthorized: true },
    );
    assert.equal(r1.status_code, 200);
    assert.equal(r2.status_code, 200);
    assert.equal(r1.body.ip, '127.0.0.1', 'req1 hit the first pinned IP');
    assert.equal(r2.body.ip, '127.0.0.2', 'req2 hit the NEW pinned IP (not the reused socket)');
    assert.deepEqual(seen1, ['Bearer ONE'], 'server #1 saw ONLY token ONE — token TWO never reached it');
    assert.deepEqual(seen2, ['Bearer TWO'], 'server #2 (the new pin) received token TWO');
  } finally {
    await new Promise((r) => s1.close(r));
    await new Promise((r) => s2.close(r));
  }
});

// ---------------------------------------------------------------------------
//  [P1] #2 — deprecated site-local fec0::/10 (fec0/fedf/feff) MUST be blocked;
//  fail-closed global-unicast-only classification.
// ---------------------------------------------------------------------------

test('#2 isDisallowedAddress: site-local fec0::/10 (fec0/fedf/feff) is BLOCKED', () => {
  for (const bad of ['fec0::1', 'fedf::1', 'feff::1', 'fec0:0:0:0:0:0:0:1', 'fee0::abcd']) {
    assert.equal(isDisallowedAddress(bad), true, `${bad} (site-local fec0::/10) must be blocked`);
  }
});

test('#2 isDisallowedAddress: fail-closed global-only — 2001:db8 doc + 2002 6to4 blocked; real global allowed', () => {
  // Special-purpose carve-outs WITHIN 2000::/3 are still rejected.
  assert.equal(isDisallowedAddress('2001:db8::1'), true, '2001:db8::/32 documentation must be blocked');
  assert.equal(isDisallowedAddress('2002:c0a8:0101::1'), true, '2002::/16 6to4 must be blocked');
  // Genuine global unicast is allowed.
  assert.equal(isDisallowedAddress('2607:f8b0:4004:800::200e'), false, 'real Google global v6 allowed');
  assert.equal(isDisallowedAddress('2400:cb00:2048:1::c629:d7a2'), false, 'real Cloudflare global v6 allowed');
});

test('#2 isDisallowedAddress: 2000::/3 boundary + reserved carve-outs inside it', () => {
  assert.equal(isDisallowedAddress('2000::1'), false, '2000::1 (first address of 2000::/3) is global');
  assert.equal(isDisallowedAddress('2606:4700:4700::1111'), false, 'real global unicast inside 2000::/3 allowed');
  // 3fff::/16 is IANA-reserved (RFC 9637 documentation 3fff::/20 lives here); it
  // is INSIDE 2000::/3 numerically but NOT globally reachable → must be blocked.
  assert.equal(isDisallowedAddress('3fff::1'), true, '3fff::/20 documentation (RFC 9637) must be blocked');
  assert.equal(isDisallowedAddress('3fff:ffff::1'), true, '3fff::/16 is IANA-reserved, NOT global → blocked');
  assert.equal(isDisallowedAddress('1fff:ffff::1'), true, '1fff:: (just below 2000::/3) is NOT global → blocked');
  assert.equal(isDisallowedAddress('4000::1'), true, '4000:: (just above 2000::/3) is NOT global → blocked');
});

test('#2 isDisallowedHost: site-local fec0::/10 literal blocked as a host string too', () => {
  for (const bad of ['fec0::1', '[fedf::1]', 'feff::1']) {
    assert.equal(isDisallowedHost(bad), true, `${bad} must be blocked as a host literal`);
  }
  assert.equal(isDisallowedHost('2607:f8b0:4004:800::200e'), false, 'a real global v6 host is allowed');
});

test('#2 requestDirect: a host resolving to fec0::1 is REFUSED (403), credential never resolved', async () => {
  const { sendImpl, calls } = captureSend({ status: 200 });
  let credResolved = 0;
  await assert.rejects(
    () => requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
      { sendImpl, resolve: async () => [{ address: 'fec0::1', family: 6 }], now: nowFn, audit: quietAudit, getCredential: async () => { credResolved += 1; return CRED; } },
    ),
    (err) => { assert.equal(err.status, 403); return true; },
  );
  assert.equal(calls.length, 0, 'nothing sent to a site-local address');
  assert.equal(credResolved, 0, 'credential never resolved on a site-local DNS answer');
});

// ---------------------------------------------------------------------------
//  [P2] #3 — double-/triple-encoded query-shaped secret must be REJECTED to a
//  fixed point, and no caller path (let alone a secret) may reach the audit line.
// ---------------------------------------------------------------------------

test('#3 assertPathHasNoDelimiter: single/double/triple-encoded ? and # all rejected to a fixed point', () => {
  const bad = [
    '/v1/%3Fapi_key%3DX',      // single-encoded ?
    '/v1/%253Fapi_key%253DX',  // double-encoded ?
    '/v1/%25253Fapi_key%25253DX', // triple-encoded ?
    '/v1/%23frag',             // single-encoded #
    '/v1/%2523frag',           // double-encoded #
    '/v1/items?x=1',           // literal ?
    '/v1/items#f',             // literal #
    '/x/%ZZ/%253Fapi_key%253DS', // poison "%ZZ" prefix — decoding CONTINUES past it and the double-encoded ? is caught
    '/x/%E0%A4%A/%253Fsecret',   // truncated UTF-8 escape ahead of a double-encoded ? — the ? is still caught
  ];
  for (const p of bad) {
    assert.throws(
      () => assertPathHasNoDelimiter(p),
      (err) => { assert.equal(err.status, 400); return /must not contain "\?" or "#"/.test(err.message); },
      `path ${p} must be rejected`,
    );
  }
  // Clean paths (incl. legitimately encoded non-delimiter bytes AND encoded
  // LITERAL percent signs with no delimiter) are accepted — tolerant fixed-point
  // canonicalization does NOT fail closed on a bare "%" derived from "%25".
  assert.equal(assertPathHasNoDelimiter('/v1/users/me/messages'), '/v1/users/me/messages');
  assert.equal(assertPathHasNoDelimiter('/v1/a%20b'), '/v1/a%20b');       // encoded space
  assert.equal(assertPathHasNoDelimiter('/v1/a%2Fb'), '/v1/a%2Fb');       // encoded slash (not a delimiter)
  assert.equal(assertPathHasNoDelimiter('/v1/caf%C3%A9'), '/v1/caf%C3%A9'); // WELL-FORMED UTF-8 escape → accepted
  assert.equal(assertPathHasNoDelimiter('/v1/100%25done'), '/v1/100%25done'); // "%25" → literal "%", no delimiter → accepted
  assert.equal(assertPathHasNoDelimiter('/v1/literal%25'), '/v1/literal%25'); // trailing "%25" → literal "%" → accepted
  assert.equal(assertPathHasNoDelimiter('/v1/%2525'), '/v1/%2525');       // double-encoded literal "%" (→ "%25" → "%") → accepted
  assert.equal(assertPathHasNoDelimiter('/100%discount'), '/100%discount'); // bare "%" then non-hex → literal, no delimiter → accepted
  assert.equal(assertPathHasNoDelimiter('/trailing%'), '/trailing%');    // bare trailing "%" → literal, no delimiter → accepted
  assert.equal(assertPathHasNoDelimiter('rel'), '/rel');                  // leading slash added
});

for (const [label, p] of [
  ['double-encoded ?', '/v1/%253Fapi_key%253DCALLER-SECRET'],
  ['triple-encoded ?', '/v1/%25253Fapi_key%25253DCALLER-SECRET'],
]) {
  test(`#3 requestDirect: ${label} path → 400, nothing sent, secret NEVER audited`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200 });
    const logged = [];
    await assert.rejects(
      () => requestDirect(
        { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: p, method: 'GET' },
        { sendImpl, resolve: publicResolve(), now: nowFn, audit: (l) => logged.push(l) },
      ),
      (err) => { assert.equal(err.status, 400); return true; },
    );
    assert.equal(calls.length, 0, 'nothing sent');
    assert.ok(!logged.some((l) => /CALLER-SECRET|api_key/i.test(l)), 'no secret substring in any audit line');
  });
}

test('#3 audit line for a legal call carries NO caller path — only a redacted marker', async () => {
  const { sendImpl } = captureSend({ status: 200 });
  const logged = [];
  await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, credential: CRED, domain: 'gmail.googleapis.com', path: '/gmail/v1/users/me/secret-segment', method: 'GET' },
    { sendImpl, resolve: publicResolve(), now: nowFn, audit: (l) => logged.push(l) },
  );
  assert.equal(logged.length, 1);
  assert.equal(logged[0], '[conn.request] → GET https://gmail.googleapis.com/<path redacted>');
  assert.ok(!logged[0].includes('secret-segment'), 'caller path segment never appears in the audit line');
});

// ---------------------------------------------------------------------------
//  [P2] #4 — EVERY structural rejection must run BEFORE any credential read. A
//  counting getter proves the getter call count is EXACTLY 0 for each. No preset
//  credential is used (that is what hid the bug); the getter is the only source.
// ---------------------------------------------------------------------------

const STRUCTURAL_CASES = [
  { name: 'literal "?" in path', args: { domain: 'gmail.googleapis.com', path: '/v1/items?api_key=S', method: 'GET' }, status: 400 },
  { name: 'single-encoded %3F in path', args: { domain: 'gmail.googleapis.com', path: '/v1/%3Fapi_key%3DS', method: 'GET' }, status: 400 },
  { name: 'double-encoded %253F in path', args: { domain: 'gmail.googleapis.com', path: '/v1/%253Fapi_key%253DS', method: 'GET' }, status: 400 },
  { name: 'literal "#" in path', args: { domain: 'gmail.googleapis.com', path: '/v1/x#frag', method: 'GET' }, status: 400 },
  { name: 'TRACE method', args: { domain: 'gmail.googleapis.com', path: '/x', method: 'TRACE' }, status: 400 },
  { name: 'CONNECT method', args: { domain: 'gmail.googleapis.com', path: '/x', method: 'CONNECT' }, status: 400 },
  { name: 'off-origin host', args: { domain: 'evil.example.com', path: '/steal', method: 'GET' }, status: 403 },
  { name: 'off-catalog port', args: { domain: 'gmail.googleapis.com:8443', path: '/x', method: 'GET' }, status: 403 },
  { name: 'literal private IP host', args: { domain: '10.0.0.5', path: '/x', method: 'GET' }, status: 403 },
  // DNS-driven cases: a public host name that resolves to a blocked address.
  { name: 'private DNS answer', args: { domain: 'gmail.googleapis.com', path: '/x', method: 'GET' }, status: 403, resolve: async () => [{ address: '10.0.0.5', family: 4 }] },
  { name: 'site-local (fec0::/10) DNS answer', args: { domain: 'gmail.googleapis.com', path: '/x', method: 'GET' }, status: 403, resolve: async () => [{ address: 'fec0::1', family: 6 }] },
];

for (const c of STRUCTURAL_CASES) {
  test(`#4 requestDirect: ${c.name} → ${c.status}, credential getter called EXACTLY 0 times, nothing sent`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200 });
    let getterCalls = 0;
    await assert.rejects(
      () => requestDirect(
        { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, ...c.args },
        {
          sendImpl,
          resolve: c.resolve || publicResolve(),
          now: nowFn,
          audit: quietAudit,
          // Counting getter — the ONLY credential source. If any structural gate
          // resolved the credential before rejecting, this count would be > 0.
          getCredential: async () => { getterCalls += 1; return CRED; },
        },
      ),
      (err) => { assert.equal(err.status, c.status, `${c.name} expected status ${c.status}`); return true; },
    );
    assert.equal(getterCalls, 0, `${c.name}: credential getter must never be called`);
    assert.equal(calls.length, 0, `${c.name}: nothing sent`);
  });
}

test('#4 requestDirect: a fully-legal request DOES call the getter exactly once, AFTER all gates', async () => {
  const { sendImpl, calls } = captureSend({ status: 200, body: { ok: true } });
  let getterCalls = 0;
  const res = await requestDirect(
    { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages', method: 'GET' },
    { sendImpl, resolve: publicResolve(), now: nowFn, audit: quietAudit, getCredential: async () => { getterCalls += 1; return CRED; } },
  );
  assert.equal(res.status_code, 200);
  assert.equal(getterCalls, 1, 'getter called exactly once on the happy path');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].assembled.headers.Authorization, 'Bearer SECRET-TOKEN');
});

// Sanity on the standalone method gate.
test('#4 assertRawMethodAllowed: rejects TRACE/CONNECT/TRACK, accepts the RAW verbs', () => {
  for (const bad of ['TRACE', 'CONNECT', 'TRACK', 'PROPFIND', '']) {
    if (bad === '') { assert.equal(assertRawMethodAllowed(bad), 'GET'); continue; } // '' → default GET
    assert.throws(() => assertRawMethodAllowed(bad), (e) => e.status === 400);
  }
  for (const ok of ['get', 'POST', 'Put', 'patch', 'DELETE', 'head', 'OPTIONS']) {
    assert.equal(assertRawMethodAllowed(ok), ok.toUpperCase());
  }
});

// ===========================================================================
//  Peer-review NEEDS-FIX #4 regressions (auto-task #12, PR #129). Two remaining
//  "make the hardening COMPLETE / fail-closed" blockers from zylos0t:
//   B1 [P1] special-purpose / global-reachability IP table was incomplete —
//           198.18/15 (benchmarking), 192.0.0/24, TEST-NETs, 2001:2::/48,
//           3fff:: documentation etc. leaked through as "global".
//   B2 [P2] a malformed %-escape made the path fixed-point gate fail-OPEN
//           (catch → return p), hiding a double-encoded delimiter behind a
//           poison prefix.
// ===========================================================================

// ---------------------------------------------------------------------------
//  B1 — COMPLETE special-purpose / global-reachability classifier (v4 + v6).
//  Data-driven CIDR table (IANA Special-Purpose registries; Globally
//  Reachable=False ⇒ reject) shared by isDisallowedAddress / isDisallowedHost.
// ---------------------------------------------------------------------------

const B1_ADDR_MATRIX = [
  // --- IPv4 special-purpose blocks that previously leaked through as global ---
  ['198.18.0.1', true, 'benchmarking 198.18.0.0/15'],
  ['198.19.255.254', true, 'benchmarking 198.18.0.0/15 (upper half)'],
  ['192.0.0.1', true, 'IETF protocol assignments 192.0.0.0/24'],
  ['192.0.2.5', true, 'TEST-NET-1 192.0.2.0/24'],
  ['198.51.100.5', true, 'TEST-NET-2 198.51.100.0/24'],
  ['203.0.113.5', true, 'TEST-NET-3 203.0.113.0/24'],
  ['192.88.99.1', true, '6to4 relay anycast 192.88.99.0/24'],
  ['240.0.0.1', true, 'reserved 240.0.0.0/4'],
  ['255.255.255.255', true, 'limited broadcast 255.255.255.255/32'],
  ['224.0.0.1', true, 'multicast 224.0.0.0/4'],
  // classic private / loopback / link-local / CGNAT still blocked
  ['10.0.0.5', true, 'private 10/8'],
  ['127.0.0.1', true, 'loopback 127/8'],
  ['169.254.169.254', true, 'cloud metadata 169.254/16'],
  ['100.64.0.1', true, 'CGNAT 100.64/10'],
  // --- IPv6 special-purpose blocks ---
  ['2001:2::1', true, 'benchmarking 2001:2::/48 (within 2001::/23, NOT an allow-exception)'],
  ['2001:db8::1', true, 'documentation 2001:db8::/32'],
  ['3fff::1', true, 'documentation 3fff::/20 (RFC 9637)'],
  ['3fff:ffff::1', true, 'IANA-reserved 3fff::/16'],
  ['2002:c0a8:0101::1', true, '6to4 2002::/16'],
  ['64:ff9b::808:808', true, 'NAT64 well-known 64:ff9b::/96'],
  ['100::1', true, 'discard-only 100::/64'],
  ['5f00::1', true, 'SRv6 SIDs 5f00::/16'],
  ['fec0::1', true, 'deprecated site-local fec0::/10'],
  ['fe80::1', true, 'link-local fe80::/10'],
  ['fc00::1', true, 'ULA fc00::/7'],
  ['::ffff:10.0.0.1', true, 'v4-mapped private (dotted)'],
  ['::ffff:a00:1', true, 'v4-mapped private (hex form)'],
  // --- genuine globally-reachable unicast that MUST stay allowed ---
  ['8.8.8.8', false, 'Google public DNS (global v4)'],
  ['1.1.1.1', false, 'Cloudflare public DNS (global v4)'],
  ['142.250.72.14', false, 'Google global v4'],
  ['2606:4700:4700::1111', false, 'Cloudflare global v6'],
  ['2607:f8b0:4004:800::200e', false, 'Google global v6'],
  ['2000::1', false, 'first address of global-unicast 2000::/3'],
  ['::ffff:8.8.8.8', false, 'v4-mapped GLOBAL address is allowed'],
  // --- IANA "Globally Reachable = True" ALLOW exceptions (longest-prefix
  //     override of a broader deny) that were wrongly 403'd before this fix ---
  ['192.0.0.9', false, 'PCP anycast 192.0.0.9/32 (GR=True carve-out of 192.0.0.0/24)'],
  ['192.0.0.10', false, 'TURN anycast 192.0.0.10/32 (GR=True carve-out of 192.0.0.0/24)'],
  ['192.31.196.1', false, 'AS112-v4 192.31.196.0/24 (GR=True)'],
  ['192.52.193.1', false, 'AMT 192.52.193.0/24 (GR=True)'],
  ['2001:1::1', false, 'PCP anycast 2001:1::1/128 (GR=True, inside 2001::/23)'],
  ['2001:1::2', false, 'TURN anycast 2001:1::2/128 (GR=True, inside 2001::/23)'],
  ['2001:3::1', false, 'AMT 2001:3::/32 (GR=True, inside 2001::/23)'],
  ['2001:4:112::1', false, 'AS112-v6 2001:4:112::/48 (GR=True, inside 2001::/23)'],
  ['2001:20::1', false, 'ORCHIDv2 2001:20::/28 (GR=True, inside 2001::/23)'],
  ['2001:30::1', false, 'DET 2001:30::/28 (GR=True, inside 2001::/23)'],
];

test('B1 isDisallowedAddress: complete special-purpose table — blocked vs. genuine global', () => {
  for (const [addr, disallowed, why] of B1_ADDR_MATRIX) {
    assert.equal(isDisallowedAddress(addr), disallowed, `${addr} — ${why}`);
  }
});

test('B1 isDisallowedHost: same verdicts for literal-IP host strings (incl. bracketed v6)', () => {
  assert.equal(isDisallowedHost('198.18.0.1'), true, '198.18/15 blocked as host literal');
  assert.equal(isDisallowedHost('203.0.113.5'), true, 'TEST-NET-3 blocked as host literal');
  assert.equal(isDisallowedHost('[2001:2::1]'), true, 'benchmarking v6 blocked as bracketed host literal');
  assert.equal(isDisallowedHost('[3fff::1]'), true, 'documentation v6 blocked as bracketed host literal');
  assert.equal(isDisallowedHost('8.8.8.8'), false, 'global v4 allowed as host literal');
  assert.equal(isDisallowedHost('[2606:4700:4700::1111]'), false, 'global v6 allowed as bracketed host literal');
});

// requestDirect: a host RESOLVING to any newly-covered special-purpose address is
// refused (403) with the credential getter NEVER called and nothing sent.
const B1_BLOCKED_DNS = [
  ['198.18.0.1', 4],
  ['192.0.0.1', 4],
  ['203.0.113.5', 4],
  ['2001:2::1', 6],
  ['3fff::1', 6],
  ['3fff:ffff::1', 6],
];
for (const [addr, family] of B1_BLOCKED_DNS) {
  test(`B1 requestDirect: DNS answer ${addr} → 403, getter=0, send=0`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200 });
    let getterCalls = 0;
    await assert.rejects(
      () => requestDirect(
        { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/x', method: 'GET' },
        { sendImpl, resolve: async () => [{ address: addr, family }], now: nowFn, audit: quietAudit, getCredential: async () => { getterCalls += 1; return CRED; } },
      ),
      (err) => { assert.equal(err.status, 403); return true; },
    );
    assert.equal(getterCalls, 0, `${addr}: credential getter must never be called`);
    assert.equal(calls.length, 0, `${addr}: nothing sent`);
  });
}

// requestDirect: a host resolving to a GENUINE global address is still allowed —
// getter called exactly once, request sent (proves the tighter table did not
// over-block real public destinations).
for (const [addr, family] of [['8.8.8.8', 4], ['2606:4700:4700::1111', 6]]) {
  test(`B1 requestDirect: genuine global DNS answer ${addr} → sent, getter=1`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200, body: { ok: true } });
    let getterCalls = 0;
    const res = await requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages', method: 'GET' },
      { sendImpl, resolve: async () => [{ address: addr, family }], now: nowFn, audit: quietAudit, getCredential: async () => { getterCalls += 1; return CRED; } },
    );
    assert.equal(res.status_code, 200);
    assert.equal(getterCalls, 1, `${addr}: getter called exactly once on the allowed global path`);
    assert.equal(calls.length, 1, `${addr}: request sent to the pinned global IP`);
  });
}

// requestDirect: a host resolving to any IANA GR=True ALLOW exception (formerly
// over-blocked by the broader deny) is allowed again — getter=1, send=1. This is
// the concrete regression for the longest-prefix explicit-allow override.
const B1_ALLOWED_EXCEPTION_DNS = [
  ['192.0.0.9', 4],   // PCP anycast (carve-out of 192.0.0.0/24)
  ['192.0.0.10', 4],  // TURN anycast (carve-out of 192.0.0.0/24)
  ['192.31.196.1', 4], // AS112-v4
  ['192.52.193.1', 4], // AMT
  ['2001:1::1', 6],   // PCP
  ['2001:1::2', 6],   // TURN
  ['2001:3::1', 6],   // AMT
  ['2001:4:112::1', 6], // AS112-v6
  ['2001:20::1', 6],  // ORCHIDv2
  ['2001:30::1', 6],  // DET
];
for (const [addr, family] of B1_ALLOWED_EXCEPTION_DNS) {
  test(`B1 requestDirect: GR=True allow-exception DNS answer ${addr} → sent, getter=1`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200, body: { ok: true } });
    let getterCalls = 0;
    const res = await requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages', method: 'GET' },
      { sendImpl, resolve: async () => [{ address: addr, family }], now: nowFn, audit: quietAudit, getCredential: async () => { getterCalls += 1; return CRED; } },
    );
    assert.equal(res.status_code, 200);
    assert.equal(getterCalls, 1, `${addr}: getter called exactly once on the allowed exception`);
    assert.equal(calls.length, 1, `${addr}: request sent to the pinned exception IP`);
  });
}

// ---------------------------------------------------------------------------
//  B2 — TOLERANT fixed-point canonicalizer. A poison prefix ("%ZZ" / truncated
//  UTF-8) ahead of a double-encoded delimiter must NOT be able to hide it:
//  decoding STEPS OVER the poison (left literal) and CONTINUES, so the deeper
//  "%253F" still surfaces "?" and is rejected. But a legitimate encoded LITERAL
//  percent with no delimiter ("%25"/"%2525"/"literal%25"/"100%25done") must be
//  ACCEPTED — it canonicalizes to a bare "%", which is NOT a delimiter and must
//  NOT fail closed. Delimiters at any encoding layer are still rejected.
// ---------------------------------------------------------------------------

for (const [label, p] of [
  ['poison "%ZZ" prefix + double-encoded ?', '/x/%ZZ/%253Fapi_key%253DCALLER-SECRET'],
  ['truncated UTF-8 prefix + double-encoded ?', '/x/%E0%A4%A/%253Fsecret'],
]) {
  test(`B2 requestDirect: ${label} → 400, getter=0, send=0, secret NEVER audited`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200 });
    const logged = [];
    let getterCalls = 0;
    await assert.rejects(
      () => requestDirect(
        { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: p, method: 'GET' },
        { sendImpl, resolve: publicResolve(), now: nowFn, audit: (l) => logged.push(l), getCredential: async () => { getterCalls += 1; return CRED; } },
      ),
      (err) => { assert.equal(err.status, 400); return true; },
    );
    assert.equal(getterCalls, 0, 'delimiter (surfaced past the poison prefix) rejected before the credential getter');
    assert.equal(calls.length, 0, 'nothing sent');
    assert.ok(!logged.some((l) => /CALLER-SECRET|api_key|secret/i.test(l)), 'no secret substring in any audit line');
  });
}

// requestDirect: a legitimate encoded-literal-percent path with NO delimiter is
// ACCEPTED end-to-end — getter=1, send=1. These were wrongly 400'd by the old
// (over-strict) fail-closed-on-derived-"%" loop.
for (const p of ['/v1/100%25done', '/v1/literal%25', '/v1/%2525', '/v1/caf%C3%A9', '/v1/a%20b', '/v1/a%2Fb']) {
  test(`B2 requestDirect: legit encoded-literal path ${p} → 200, getter=1, send=1`, async () => {
    const { sendImpl, calls } = captureSend({ status: 200, body: { ok: true } });
    let getterCalls = 0;
    const res = await requestDirect(
      { orgId: 'o', connection: { id: 'c1' }, catalog: CATALOG, catalogFetchedAt: FRESH, domain: 'gmail.googleapis.com', path: p, method: 'GET' },
      { sendImpl, resolve: publicResolve(), now: nowFn, audit: quietAudit, getCredential: async () => { getterCalls += 1; return CRED; } },
    );
    assert.equal(res.status_code, 200, `${p} accepted`);
    assert.equal(getterCalls, 1, `${p}: getter called exactly once`);
    assert.equal(calls.length, 1, `${p}: request sent`);
  });
}

test('B2 assertPathHasNoDelimiter: poison+hidden-delimiter fails closed; legit encoded-literal % succeeds', () => {
  // A delimiter surfacing at ANY layer is rejected — even behind a poison prefix
  // that used to halt decoding.
  assert.throws(() => assertPathHasNoDelimiter('/x/%ZZ/%253F'), (e) => e.status === 400, 'poison "%ZZ" must not hide the double-encoded ?');
  assert.throws(() => assertPathHasNoDelimiter('/x/%E0%A4%A/%253F'), (e) => e.status === 400, 'truncated UTF-8 must not hide the double-encoded ?');
  // Legit encoded-literal-percent paths (no delimiter) reach a fixed point and
  // are ACCEPTED — tolerant decoding leaves undecodable/invalid "%" literal
  // rather than failing closed.
  assert.equal(assertPathHasNoDelimiter('/v1/a%20b'), '/v1/a%20b');
  assert.equal(assertPathHasNoDelimiter('/v1/caf%C3%A9'), '/v1/caf%C3%A9');
  assert.equal(assertPathHasNoDelimiter('/v1/a%2Fb'), '/v1/a%2Fb');
  assert.equal(assertPathHasNoDelimiter('/v1/100%25done'), '/v1/100%25done');
  assert.equal(assertPathHasNoDelimiter('/v1/literal%25'), '/v1/literal%25');
  assert.equal(assertPathHasNoDelimiter('/v1/%2525'), '/v1/%2525');
  assert.equal(assertPathHasNoDelimiter('/100%discount'), '/100%discount');
  assert.equal(assertPathHasNoDelimiter('/trailing%'), '/trailing%');
});
