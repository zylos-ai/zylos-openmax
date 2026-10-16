import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleRequest, invokeDirect } from './direct-exec.js';
import {
  PageTokenCache,
  parseExchangeMarker,
  validateGraphId,
  graphVersionOf,
  TOKEN_EXCHANGE_HEADER,
} from './meta-page-token.js';

const USER_TOKEN = 'EAAUSERTOKEN_0123456789_secret_user';
const PAGE_TOKEN = 'EAAPAGETOKEN_0123456789_secret_page';
const PAGE_TOKEN_2 = 'EAAPAGETOKEN_2_ABCDEFGHIJ_secret_page2';
const IG_PAGE_TOKEN = 'EAAIGPAGETOKEN_9876543210_secret_igpage';

const CRED = { credential_mode: 'direct', token_type: 'bearer', access_token: USER_TOKEN };
const CONN = { id: 'conn-meta-1', applicationId: 'app-meta', slug: 'meta' };

const CREATE_POST = {
  toolkit: 'meta_pages',
  action: 'create_page_post',
  method: 'POST',
  url_template: 'https://graph.facebook.com/v26.0/{page_id}/feed',
  headers_template: { [TOKEN_EXCHANGE_HEADER]: 'meta_page:page_id' },
  input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
};
const CREATE_COMMENT = {
  toolkit: 'meta_pages',
  action: 'create_comment',
  method: 'POST',
  url_template: 'https://graph.facebook.com/v26.0/{object_id}/comments',
  headers_template: { 'x-openmax-token-exchange': 'meta_page:page_id' },
  input_schema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] },
};
const IG_PRIVATE_REPLY = {
  toolkit: 'meta_messaging',
  action: 'send_ig_private_reply',
  method: 'POST',
  url_template: 'https://graph.facebook.com/v26.0/{ig_user_id}/messages',
  headers_template: { [TOKEN_EXCHANGE_HEADER]: 'meta_ig_page:ig_user_id' },
  input_schema: { type: 'object', properties: { recipient: { type: 'object' }, message: { type: 'object' } } },
};
const ME = {
  toolkit: 'meta_account',
  action: 'me',
  method: 'GET',
  url_template: 'https://graph.facebook.com/v26.0/me?fields=id,name',
  input_schema: '',
};
const CATALOG = [CREATE_POST, CREATE_COMMENT, IG_PRIVATE_REPLY, ME];

// Router fetch double: `routes` is a list of [predicate(url, opts), response]
// or [predicate, response[]] (consumed in order, last one sticks). Records calls.
function routerFetch(routes) {
  const calls = [];
  const queues = routes.map(([, r]) => (Array.isArray(r) ? [...r] : [r]));
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const i = routes.findIndex(([pred]) => pred(url, opts));
    if (i < 0) throw new Error(`unexpected fetch ${opts.method} ${url}`);
    const q = queues[i];
    const r = q.length > 1 ? q.shift() : q[0];
    const text = JSON.stringify(r.body ?? {});
    const bytes = new TextEncoder().encode(text);
    return {
      status: r.status ?? 200,
      headers: new Map([['content-type', 'application/json']]),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => text,
    };
  };
  return { impl, calls };
}

const isExchange = (id) => (u) => u === `https://graph.facebook.com/v26.0/${id}?fields=access_token`;
const isAccounts = (u) => u.startsWith('https://graph.facebook.com/v26.0/me/accounts?');
const isFeed = (id) => (u, o) => u === `https://graph.facebook.com/v26.0/${id}/feed` && o.method === 'POST';
const authOf = (call) => call.opts.headers.Authorization;

function sink() {
  const lines = [];
  const fn = (l) => { lines.push(String(l)); };
  return { lines, fn };
}

function deps(fetchImpl, extra = {}) {
  const logs = sink();
  return {
    logs,
    d: {
      fetchImpl,
      pageTokenCache: new PageTokenCache(),
      audit: logs.fn,
      log: logs.fn,
      warn: logs.fn,
      ...extra,
    },
  };
}

function assertNoTokens(texts) {
  for (const t of texts) {
    for (const secret of [USER_TOKEN, PAGE_TOKEN, PAGE_TOKEN_2, IG_PAGE_TOKEN]) {
      assert.ok(!String(t).includes(secret), `secret leaked into: ${t}`);
    }
  }
}

// ---------------------------------------------------------------------------

test('B2 marker absent → unchanged: user token, single call, no exchange', async () => {
  const f = routerFetch([[(u) => u.startsWith('https://graph.facebook.com/v26.0/me?'), { body: { id: '1', name: 'u' } }]]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_account/me', params: {}, catalog: CATALOG, credential: CRED }, d);
  assert.equal(r.status_code, 200);
  assert.equal(f.calls.length, 1);
  assert.equal(authOf(f.calls[0]), `Bearer ${USER_TOKEN}`);
});

test('B2 exchange success: derives page token on Graph, sends real call with Bearer <page token>', async () => {
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN, id: '111' } }],
    [isFeed('111'), { body: { id: '111_999' } }],
  ]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({
    orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post',
    params: { page_id: '111', message: 'hello' }, catalog: CATALOG, credential: CRED,
  }, d);
  assert.deepEqual(r.body, { id: '111_999' });
  assert.equal(f.calls.length, 2);
  // exchange: fixed Graph origin, user token, redirects not followed
  assert.equal(authOf(f.calls[0]), `Bearer ${USER_TOKEN}`);
  assert.equal(f.calls[0].opts.redirect, 'manual');
  // real call: page token REPLACES the user token; no access_token param anywhere
  assert.equal(authOf(f.calls[1]), `Bearer ${PAGE_TOKEN}`);
  assert.ok(!f.calls[1].url.includes('access_token'));
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { message: 'hello' });
});

test('B2 marker header is stripped before sending (any case), never reaches the provider', async () => {
  // assembleRequest alone
  const a = assembleRequest(CREATE_COMMENT, { object_id: '1_2', page_id: '1', message: 'x' }, 'tok');
  assert.ok(!Object.keys(a.headers).some((h) => h.toLowerCase() === 'x-openmax-token-exchange'));
  // end to end
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const { d } = deps(f.impl);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  for (const c of f.calls) {
    assert.ok(!Object.keys(c.opts.headers).some((h) => h.toLowerCase() === 'x-openmax-token-exchange'));
  }
});

test('B2 page_id not used by the URL (object-keyed action) is consumed, not sent in the body', async () => {
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [(u) => u === 'https://graph.facebook.com/v26.0/111_222/comments', { body: { id: 'c1' } }],
  ]);
  const { d } = deps(f.impl);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_comment', params: { object_id: '111_222', page_id: '111', message: 'hi' }, catalog: CATALOG, credential: CRED }, d);
  assert.equal(authOf(f.calls[1]), `Bearer ${PAGE_TOKEN}`);
  assert.deepEqual(JSON.parse(f.calls[1].opts.body), { message: 'hi' });
});

test('B2 cache hit: a second invoke for the same (connection, user token, page) skips the exchange', async () => {
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const { d, logs } = deps(f.impl);
  const call = () => invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  await call();
  await call();
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 1);
  assert.equal(f.calls.length, 3);
  assert.equal(authOf(f.calls[2]), `Bearer ${PAGE_TOKEN}`);
  assert.ok(logs.lines.some((l) => l.includes('cache hit')));
  // a different user token (refreshed/reconnected) does NOT reuse the entry
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: { ...CRED, access_token: 'EAAOTHERUSER_xxxxxxxxxx' } }, d);
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 2);
});

test('B2 cache TTL: an expired entry is re-derived', async () => {
  let t = 1_000_000;
  const cache = new PageTokenCache({ ttlMs: 1000, now: () => t });
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'p' } }],
  ]);
  const { d } = deps(f.impl, { pageTokenCache: cache });
  const call = () => invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  await call();
  t += 1001;
  await call();
  assert.equal(f.calls.filter((c) => isExchange('111')(c.url)).length, 2);
});

test('B2 Graph 190 on the real call → invalidate, re-derive, retry ONCE', async () => {
  const f = routerFetch([
    [isExchange('111'), [{ body: { access_token: PAGE_TOKEN } }, { body: { access_token: PAGE_TOKEN_2 } }]],
    [isFeed('111'), [
      { status: 400, body: { error: { code: 190, type: 'OAuthException', message: 'Error validating access token' } } },
      { body: { id: 'ok' } },
    ]],
  ]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.deepEqual(r.body, { id: 'ok' });
  assert.deepEqual(f.calls.map((c) => authOf(c)), [
    `Bearer ${USER_TOKEN}`, `Bearer ${PAGE_TOKEN}`, `Bearer ${USER_TOKEN}`, `Bearer ${PAGE_TOKEN_2}`,
  ]);
  // the retried token is now the cached one
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.equal(authOf(f.calls[4]), `Bearer ${PAGE_TOKEN_2}`);
});

test('B2 Graph 190 twice → surfaced after one retry (no loop)', async () => {
  const err190 = { status: 400, body: { error: { code: 190, type: 'OAuthException', message: 'expired' } } };
  const f = routerFetch([
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), err190],
  ]);
  const { d } = deps(f.impl);
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.equal(r.status_code, 400);
  assert.equal(r.body.error.code, 190);
  assert.equal(f.calls.length, 4); // exchange, call, re-exchange, retry
});

test('B2 Graph 190 on the exchange (user token invalid) → one credential re-acquire, then retry', async () => {
  const fresh = { ...CRED, access_token: 'EAAFRESHUSER_zzzzzzzzzz' };
  const f = routerFetch([
    [(u, o) => isExchange('111')(u) && o.headers.Authorization === `Bearer ${USER_TOKEN}`, { status: 400, body: { error: { code: 190, message: 'Session has expired' } } }],
    [isExchange('111'), { body: { access_token: PAGE_TOKEN } }],
    [isFeed('111'), { body: { id: 'ok' } }],
  ]);
  let acquired = 0;
  const { d } = deps(f.impl, { acquire: async () => { acquired += 1; return fresh; }, saveCache: () => {} });
  const r = await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  assert.deepEqual(r.body, { id: 'ok' });
  assert.equal(acquired, 1);
  // without acquire the 401 is surfaced with a clear message
  const f2 = routerFetch([[isExchange('111'), { status: 400, body: { error: { code: 190, message: 'Session has expired' } } }]]);
  const { d: d2 } = deps(f2.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d2),
    (e) => e.status === 401 && /re-authorized/.test(e.message),
  );
});

test('B2 non-numeric / unsafe page_id rejected before any network call', async () => {
  for (const bad of ['abc', '111/../me', '111?x=1', '', '1 1', 2 ** 60, -1, { id: 1 }, undefined]) {
    const f = routerFetch([]);
    const { d } = deps(f.impl);
    await assert.rejects(
      invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: bad, message: 'm' }, catalog: CATALOG, credential: CRED }, d),
      (e) => e.status === 400 && /page_id/.test(e.message),
      `expected 400 for ${String(bad)}`,
    );
    assert.equal(f.calls.length, 0);
  }
  assert.equal(validateGraphId(12345, 'page_id'), '12345');
});

test('B2 no access to the Page → clear 403 for the LLM, no real call', async () => {
  const f = routerFetch([[isExchange('222'), { body: { id: '222' } }]]); // no access_token field
  const { d } = deps(f.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '222', message: 'm' }, catalog: CATALOG, credential: CRED }, d),
    (e) => e.status === 403 && /Facebook Page 222/.test(e.message) && /meta_account\/list_pages/.test(e.message),
  );
  assert.equal(f.calls.length, 1);
  // Graph permission error is surfaced with its code
  const f2 = routerFetch([[isExchange('222'), { status: 400, body: { error: { code: 100, type: 'GraphMethodException', message: 'Unsupported get request' } } }]]);
  const { d: d2 } = deps(f2.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '222', message: 'm' }, catalog: CATALOG, credential: CRED }, d2),
    (e) => e.status === 403 && /code 100/.test(e.message),
  );
});

test('B2 IG: page resolved from ig_user_id via paginated /me/accounts, then cached', async () => {
  const IG = '17841400000000001'; // 17 digits — must stay a string
  const f = routerFetch([
    [(u) => isAccounts(u) && !u.includes('after='), { body: {
      data: [{ id: '301', access_token: PAGE_TOKEN, instagram_business_account: { id: '17841400000000999' } }],
      paging: { cursors: { after: 'CUR1' }, next: 'https://graph.facebook.com/v26.0/me/accounts?after=CUR1' },
    } }],
    [(u) => isAccounts(u) && u.includes('after=CUR1'), { body: {
      data: [{ id: '302', access_token: IG_PAGE_TOKEN, instagram_business_account: { id: IG } }],
      paging: { cursors: { after: 'CUR2' } },
    } }],
    [(u) => u === `https://graph.facebook.com/v26.0/${IG}/messages`, { body: { recipient_id: 'x' } }],
  ]);
  const { d } = deps(f.impl);
  const params = { ig_user_id: IG, recipient: { comment_id: '9' }, message: { text: 'hi' } };
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params, catalog: CATALOG, credential: CRED }, d);
  assert.equal(f.calls.length, 3);
  assert.ok(f.calls[0].url.includes('fields=id,access_token,instagram_business_account'));
  assert.equal(authOf(f.calls[2]), `Bearer ${IG_PAGE_TOKEN}`);
  assert.deepEqual(JSON.parse(f.calls[2].opts.body), { recipient: { comment_id: '9' }, message: { text: 'hi' } });
  // cached: no further /me/accounts
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params, catalog: CATALOG, credential: CRED }, d);
  assert.equal(f.calls.filter((c) => isAccounts(c.url)).length, 2);
  // the side-cached page 301 serves a meta_page action without an exchange
  const f2calls = f.calls.length;
  await assert.rejects(invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '301', message: 'm' }, catalog: CATALOG, credential: CRED }, d), /unexpected fetch POST https:\/\/graph.facebook.com\/v26.0\/301\/feed/);
  assert.equal(f.calls.length, f2calls + 1); // only the (unrouted) real call, no exchange
});

test('B2 IG: no linked Page → 403; number ig_user_id beyond safe integer → 400', async () => {
  const f = routerFetch([[isAccounts, { body: { data: [{ id: '301', access_token: PAGE_TOKEN }], paging: {} } }]]);
  const { d } = deps(f.impl);
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: '17841400000000001' }, catalog: CATALOG, credential: CRED }, d),
    (e) => e.status === 403 && /Instagram account 17841400000000001/.test(e.message),
  );
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: 17841400000000001 }, catalog: CATALOG, credential: CRED }, d),
    (e) => e.status === 400 && /string/.test(e.message),
  );
});

test('B2 fail closed: unknown marker kind / non-Graph action → 422, no network', async () => {
  const f = routerFetch([]);
  const { d } = deps(f.impl);
  const unknown = { ...CREATE_POST, action: 'u', headers_template: { [TOKEN_EXCHANGE_HEADER]: 'meta_business:page_id' } };
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/u', params: { page_id: '1', message: 'm' }, catalog: [unknown], credential: CRED }, d),
    (e) => e.status === 422,
  );
  const evil = { ...CREATE_POST, action: 'evil', url_template: 'https://attacker.example/{page_id}' };
  await assert.rejects(
    invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/evil', params: { page_id: '1', message: 'm' }, catalog: [evil], credential: CRED }, d),
    (e) => e.status === 422 && /graph\.facebook\.com/.test(e.message),
  );
  assert.equal(f.calls.length, 0);
  assert.throws(() => parseExchangeMarker('meta_page'), (e) => e.status === 422);
  assert.deepEqual(parseExchangeMarker(' meta_page : page_id '), { kind: 'meta_page', param: 'page_id' });
});

test('B2 Graph version follows the action template', () => {
  assert.equal(graphVersionOf('https://graph.facebook.com/v27.0/{page_id}/feed'), 'v27.0');
  assert.equal(graphVersionOf('https://example.com/x'), 'v26.0');
});

test('B2 tokens never appear in audit/log lines or error messages', async () => {
  // Graph echoes the token in an error message → scrubbed in our error
  const f = routerFetch([[isExchange('111'), { status: 400, body: { error: { code: 200, message: `bad token ${USER_TOKEN}` } } }]]);
  const { d, logs } = deps(f.impl);
  let err;
  try {
    await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d);
  } catch (e) { err = e; }
  assert.ok(err);
  assertNoTokens([err.message, ...logs.lines]);

  // success + cache hit + 190 retry + IG paths: nothing in logs either
  const f2 = routerFetch([
    [isExchange('111'), [{ body: { access_token: PAGE_TOKEN } }, { body: { access_token: PAGE_TOKEN_2 } }]],
    [isFeed('111'), [{ status: 400, body: { error: { code: 190, message: 'x' } } }, { body: { id: 'ok' } }]],
    [isAccounts, { body: { data: [{ id: '302', access_token: IG_PAGE_TOKEN, instagram_business_account: { id: '178414' } }] } }],
    [(u) => u.endsWith('/178414/messages'), { body: {} }],
  ]);
  const { d: d2, logs: logs2 } = deps(f2.impl);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d2);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_pages/create_page_post', params: { page_id: '111', message: 'm' }, catalog: CATALOG, credential: CRED }, d2);
  await invokeDirect({ orgId: 'o', connection: CONN, actionSlug: 'meta_messaging/send_ig_private_reply', params: { ig_user_id: '178414' }, catalog: CATALOG, credential: CRED }, d2);
  assert.ok(logs2.lines.length > 0);
  assertNoTokens(logs2.lines);
});
