import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveActionDef,
  validateParams,
  assembleRequest,
  isTokenRefreshable,
  isTokenNearExpiry,
  chooseExecMode,
  sendDirect,
  invokeDirect,
  MAX_RESPONSE_BYTES,
} from './direct-exec.js';

// Silence the audit sink for tests (it writes to stderr by default).
const quietAudit = () => {};

// A fetch double: returns a Response-like object with a status, JSON/text body,
// and Headers. Records each call so assembly can be asserted end-to-end.
function fakeFetch(responses) {
  const calls = [];
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    const r = queue.length > 1 ? queue.shift() : queue[0];
    const bodyText = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return {
      status: r.status ?? 200,
      headers: new Map(Object.entries(r.headers || { 'content-type': 'application/json' })),
      text: async () => bodyText,
    };
  };
  return { impl, calls };
}

const GMAIL_GET = {
  toolkit: 'gmail-messages',
  action: 'get',
  method: 'GET',
  url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/{id}?format={format}',
  input_schema: '',
};

const GMAIL_SEND = {
  toolkit: 'gmail-messages',
  action: 'send',
  method: 'POST',
  url_template: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
  headers_template: { 'X-Trace': 'req-{traceId}' },
  input_schema: { type: 'object', properties: { raw: { type: 'string' } }, required: ['raw'] },
};

// ---------------------------------------------------------------------------
//  O1 — resolution + assembly from url_template + params
// ---------------------------------------------------------------------------

test('O1 resolveActionDef: matches "toolkit/action", falls back to bare action', () => {
  const cat = [GMAIL_GET, GMAIL_SEND];
  assert.equal(resolveActionDef(cat, 'gmail-messages/get'), GMAIL_GET);
  assert.equal(resolveActionDef(cat, 'send'), GMAIL_SEND);
  assert.equal(resolveActionDef(cat, 'nope/missing'), null);
});

test('O1 assembleRequest: fills path + query placeholders, injects Bearer, no body on GET', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'abc123', format: 'full' }, 'TOK');
  assert.equal(req.method, 'GET');
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=full');
  assert.equal(req.headers.Authorization, 'Bearer TOK');
  assert.equal(req.body, undefined);
});

test('O1 assembleRequest: an omitted optional QUERY placeholder drops the whole pair (no literal {token})', () => {
  const req = assembleRequest(GMAIL_GET, { id: 'abc123' }, 'TOK'); // no format
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123');
  assert.ok(!req.url.includes('{'), 'no unfilled placeholder may reach the URL');
});

test('O1 assembleRequest: a missing required PATH placeholder throws 400', () => {
  assert.throws(
    () => assembleRequest(GMAIL_GET, { format: 'full' }, 'TOK'),
    (e) => e.status === 400 && /path param "id"/.test(e.message),
  );
});

test('O1 assembleRequest: remaining params become the JSON body (write method) + templated header', () => {
  const req = assembleRequest(GMAIL_SEND, { raw: 'BASE64', traceId: 'xyz' }, 'TOK');
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
  assert.equal(req.headers['X-Trace'], 'req-xyz'); // header template filled + param consumed
  assert.equal(req.headers['Content-Type'], 'application/json');
  assert.deepEqual(req.body, { raw: 'BASE64' }); // traceId consumed by header, not in body
});

test('O1 assembleRequest: url_template missing → 422 (catalog too old for direct)', () => {
  assert.throws(
    () => assembleRequest({ toolkit: 't', action: 'a', method: 'GET' }, {}, 'TOK'),
    (e) => e.status === 422,
  );
});

test('O1 assembleRequest: a headers_template Authorization can NOT override the injected token', () => {
  const def = { ...GMAIL_GET, headers_template: { Authorization: 'Bearer EVIL' } };
  const req = assembleRequest(def, { id: 'x' }, 'GOOD');
  assert.equal(req.headers.Authorization, 'Bearer GOOD');
});

test('O1 sendDirect: passthrough result shape {status_code, headers, body}, JSON parsed', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: { messages: [{ id: '1' }] } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'TOK'), { fetchImpl: impl });
  assert.equal(out.status_code, 200);
  assert.deepEqual(out.body, { messages: [{ id: '1' }] });
  assert.equal(out.headers['content-type'], 'application/json');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer TOK');
});

test('O1 sendDirect: non-JSON body is passed through raw (not transformed)', async () => {
  const { impl } = fakeFetch({ status: 200, body: 'plain text', headers: { 'content-type': 'text/plain' } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'T'), { fetchImpl: impl });
  assert.equal(out.body, 'plain text');
});

test('O1 sendDirect: an over-cap body is truncated + flagged, never buffered unbounded', async () => {
  const huge = 'x'.repeat(MAX_RESPONSE_BYTES + 10);
  const { impl } = fakeFetch({ status: 200, body: huge, headers: { 'content-type': 'text/plain' } });
  const out = await sendDirect(assembleRequest(GMAIL_GET, { id: '1' }, 'T'), { fetchImpl: impl });
  assert.equal(out.truncated, true);
  assert.equal(out.body.length, MAX_RESPONSE_BYTES);
});

test('O1 validateParams: enforces required + declared types, lenient on unknowns', () => {
  assert.equal(validateParams({ raw: 'x' }, GMAIL_SEND.input_schema).ok, true);
  assert.equal(validateParams({}, GMAIL_SEND.input_schema).ok, false); // missing required raw
  assert.equal(validateParams({ raw: 123 }, GMAIL_SEND.input_schema).ok, false); // wrong type
  assert.equal(validateParams({ raw: 'x', extra: 1 }, GMAIL_SEND.input_schema).ok, true); // unknown ok
  assert.equal(validateParams({ anything: 1 }, '').ok, true); // empty schema → no validation
});

// ---------------------------------------------------------------------------
//  O2 — mode split
// ---------------------------------------------------------------------------

test('O2 chooseExecMode: direct only when a cached credential is credential_mode=direct', () => {
  assert.equal(chooseExecMode({ credential_mode: 'direct', access_token: 't' }), 'direct');
  assert.equal(chooseExecMode({ credential_mode: 'proxy' }), 'proxy');
  assert.equal(chooseExecMode(null), 'proxy'); // no local cred file → proxy path
  assert.equal(chooseExecMode(undefined), 'proxy');
});

// ---------------------------------------------------------------------------
//  O4 — token lifecycle: refreshable detection + near-expiry + reactive 401
// ---------------------------------------------------------------------------

test('O4 isTokenRefreshable: OAuth yes, api_key no', () => {
  assert.equal(isTokenRefreshable({ token_type: 'Bearer' }), true);
  assert.equal(isTokenRefreshable({}), true); // GitHub-style no-expiry OAuth still refreshable
  assert.equal(isTokenRefreshable({ token_type: 'api_key' }), false);
  assert.equal(isTokenRefreshable({ auth_type: 'api_key' }), false);
});

test('O4 isTokenNearExpiry: near/expired vs comfortable vs no-expiry', () => {
  const now = 1_000_000_000_000;
  assert.equal(isTokenNearExpiry({ expires_at: now + 5_000 }, now, 60_000), true); // within skew
  assert.equal(isTokenNearExpiry({ expires_at: now + 3_600_000 }, now, 60_000), false); // 1h out
  assert.equal(isTokenNearExpiry({}, now, 60_000), false); // no expiry → not proactive
  // epoch-seconds form is normalized to ms
  assert.equal(isTokenNearExpiry({ expires_at: Math.floor((now + 5_000) / 1000) }, now, 60_000), true);
});

test('O4 invokeDirect: near-expiry OAuth token → proactive refresh BEFORE the send', async () => {
  const now = 2_000_000_000_000;
  const { impl, calls } = fakeFetch({ status: 200, body: { ok: true } });
  const acquired = [];
  const saved = [];
  const out = await invokeDirect(
    {
      orgId: 'org-1',
      connection: { id: 'conn-1', applicationId: 'app-1', slug: 'gmail' },
      actionSlug: 'gmail-messages/get',
      params: { id: 'm1' },
      catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'OLD', expires_at: now + 1_000 },
    },
    {
      fetchImpl: impl,
      now: () => now,
      acquire: async (oid, cid) => { acquired.push([oid, cid]); return { credential_mode: 'direct', token_type: 'Bearer', access_token: 'NEW', expires_at: now + 3_600_000 }; },
      saveCache: (cid, cred) => saved.push([cid, cred.access_token]),
      audit: quietAudit,
    },
  );
  assert.deepEqual(acquired, [['org-1', 'conn-1']], 'should refresh exactly once, before sending');
  assert.deepEqual(saved, [['conn-1', 'NEW']], 'refreshed token must be re-saved locally');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer NEW', 'send must use the refreshed token');
  assert.equal(out.status_code, 200);
});

test('O4 invokeDirect: a comfortable OAuth token is NOT refreshed', async () => {
  const now = 2_000_000_000_000;
  const { impl } = fakeFetch({ status: 200, body: {} });
  let acquires = 0;
  await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'T', expires_at: now + 3_600_000 },
    },
    { fetchImpl: impl, now: () => now, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0);
});

test('O4 invokeDirect: provider 401 on OAuth → reactive refresh ONCE, retry, succeed', async () => {
  const { impl, calls } = fakeFetch([
    { status: 401, body: { error: 'expired' } },
    { status: 200, body: { ok: true } },
  ]);
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'OLD' },
    },
    {
      fetchImpl: impl,
      acquire: async () => { acquires++; return { credential_mode: 'direct', token_type: 'Bearer', access_token: 'NEW' }; },
      audit: quietAudit,
    },
  );
  assert.equal(acquires, 1, 'reactive refresh must happen exactly once');
  assert.equal(calls.length, 2, 'one retry after refresh');
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer NEW');
  assert.equal(out.status_code, 200);
});

test('O4 invokeDirect: still 401 after the single reactive refresh → surfaced, no loop', async () => {
  const { impl, calls } = fakeFetch([
    { status: 401, body: { error: 'e1' } },
    { status: 401, body: { error: 'e2' } },
  ]);
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'Bearer', access_token: 'OLD' },
    },
    { fetchImpl: impl, acquire: async () => { acquires++; return { access_token: 'NEW', token_type: 'Bearer', credential_mode: 'direct' }; }, audit: quietAudit },
  );
  assert.equal(acquires, 1, 'must NOT refresh more than once (no loop)');
  assert.equal(calls.length, 2, 'exactly the original + one retry');
  assert.equal(out.status_code, 401, 'the second 401 is surfaced to the caller');
});

test('O4 invokeDirect: api_key 401 → surfaced immediately, NEVER refreshed', async () => {
  const { impl, calls } = fakeFetch({ status: 401, body: { error: 'bad key' } });
  let acquires = 0;
  const out = await invokeDirect(
    {
      orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/get',
      params: { id: 'm' }, catalog: [GMAIL_GET],
      credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'KEY' },
    },
    { fetchImpl: impl, acquire: async () => { acquires++; return {}; }, audit: quietAudit },
  );
  assert.equal(acquires, 0, 'api_key is static — never re-acquired');
  assert.equal(calls.length, 1);
  assert.equal(out.status_code, 401);
});

test('O4 invokeDirect: unknown action → 404 before any send', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirect(
      { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'nope/missing', params: {}, catalog: [GMAIL_GET], credential: { credential_mode: 'direct', access_token: 'T' } },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 404,
  );
  assert.equal(calls.length, 0, 'no HTTP call for an unresolved action');
});

test('O4 invokeDirect: params failing input_schema → 400 before any send', async () => {
  const { impl, calls } = fakeFetch({ status: 200, body: {} });
  await assert.rejects(
    () => invokeDirect(
      { orgId: 'o', connection: { id: 'c', applicationId: 'a' }, actionSlug: 'gmail-messages/send', params: {}, catalog: [GMAIL_SEND], credential: { credential_mode: 'direct', access_token: 'T' } },
      { fetchImpl: impl, audit: quietAudit },
    ),
    (e) => e.status === 400,
  );
  assert.equal(calls.length, 0);
});
