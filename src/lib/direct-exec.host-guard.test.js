// Host protection for direct-mode requests: connection-owned url_placeholders
// cannot be overridden by caller params, and the final request origin must be
// one the catalog / connection defines (or, for a caller-supplied host, one the
// connector's static host rule admits) — before any credential is attached.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { assembleRequest, invokeDirect, STATIC_HOST_RULES } from './direct-exec.js';

const quietAudit = () => {};

function fakeFetch(body = { ok: true }) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const text = JSON.stringify(body);
    const bytes = new TextEncoder().encode(text);
    return {
      status: 200,
      headers: new Map([['content-type', 'application/json']]),
      body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }),
      text: async () => text,
    };
  };
  return { impl, calls };
}

const def = (name, method, url, extra = {}) => {
  const [toolkit, action] = name.split('/');
  return { toolkit, action, method, url_template: url, input_schema: '', ...extra };
};

// cws-connect seeds (000075 / 000074): whole-host placeholders.
const SHOPIFY_LIST = def('shopify-orders/list', 'GET', 'https://{shop}/admin/api/2026-07/orders.json?status={status}');
const SHOPIFY_CREATE = def('shopify-products/create', 'POST', 'https://{shop}/admin/api/2026-07/products.json');
const SHOPIFY_CATALOG = [SHOPIFY_LIST, SHOPIFY_CREATE];
const SHOPIFY_INJ = { location: 'header', name: 'X-Shopify-Access-Token', value_template: '{token}' };
const shopifyCred = (uph) => ({
  credential_mode: 'direct', token_type: 'bearer', access_token: 'shpat_SECRET', auth_injection: SHOPIFY_INJ,
  ...(uph ? { url_placeholders: uph } : {}),
});

const AMAZON_ORDERS = def('amazon-orders/get-orders', 'GET', 'https://{region_host}/orders/v0/orders?MarketplaceIds={marketplace_ids}');
const AMAZON_CATALOG = [AMAZON_ORDERS];
const AMAZON_INJ = { location: 'header', name: 'x-amz-access-token', value_template: '{token}' };
const amazonCred = (uph) => ({
  credential_mode: 'direct', token_type: 'bearer', access_token: 'Atza|SECRET', auth_injection: AMAZON_INJ,
  ...(uph ? { url_placeholders: uph } : {}),
});

function invoke({ slug, actionSlug, params, catalog, credential }, fetchImpl) {
  return invokeDirect(
    { orgId: 'o', connection: { id: 'c1', applicationId: 'app', slug }, actionSlug, params, catalog, credential },
    { fetchImpl, audit: quietAudit },
  );
}

function assertNoSecret(e) {
  assert.ok(!/SECRET/.test(e.message), 'error must not carry the token');
  return true;
}

// ---------------------------------------------------------------------------
//  1. url_placeholders are authoritative
// ---------------------------------------------------------------------------

test('host-guard Shopify: caller shop=attacker.example is refused (400) when url_placeholders has shop — zero requests', async () => {
  const { impl, calls } = fakeFetch();
  await assert.rejects(
    () => invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-orders/list', params: { shop: 'attacker.example' }, catalog: SHOPIFY_CATALOG, credential: shopifyCred({ shop: 'acme.myshopify.com' }) }, impl),
    (e) => e.status === 400 && e.code === 'connection_placeholder_override' && /"shop"/.test(e.message) && assertNoSecret(e),
  );
  assert.equal(calls.length, 0);
});

test('host-guard Shopify: the clash rule does not depend on the slug (unknown slug still refused)', () => {
  assert.throws(
    () => assembleRequest(SHOPIFY_LIST, { shop: 'attacker.example' }, 'T', { shop: 'acme.myshopify.com' }),
    (e) => e.status === 400 && /set by the connection/.test(e.message),
  );
});

test('host-guard Shopify: legit calls work — shop omitted, or echoed (any case) — and go to the connection shop with the Shopify header', async () => {
  for (const params of [{ status: 'open' }, { shop: 'acme.myshopify.com', status: 'open' }, { shop: ' ACME.myshopify.com ', status: 'open' }]) {
    const { impl, calls } = fakeFetch();
    const out = await invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-orders/list', params, catalog: SHOPIFY_CATALOG, credential: shopifyCred({ shop: 'acme.myshopify.com' }) }, impl);
    assert.equal(out.status_code, 200);
    assert.equal(calls[0].url, 'https://acme.myshopify.com/admin/api/2026-07/orders.json?status=open');
    assert.equal(calls[0].opts.headers['X-Shopify-Access-Token'], 'shpat_SECRET');
  }
});

test('host-guard Shopify: an echoed shop on a POST does not leak into the body', async () => {
  const { impl, calls } = fakeFetch();
  await invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-products/create', params: { shop: 'acme.myshopify.com', product: { title: 'T' } }, catalog: SHOPIFY_CATALOG, credential: shopifyCred({ shop: 'acme.myshopify.com' }) }, impl);
  assert.equal(calls[0].url, 'https://acme.myshopify.com/admin/api/2026-07/products.json');
  assert.deepEqual(JSON.parse(calls[0].opts.body), { product: { title: 'T' } });
});

test('host-guard Amazon (after cws-connect delivers region_host): a differing caller region_host is refused 400; omitted/equal uses the connection value', async () => {
  const cred = amazonCred({ region_host: 'sellingpartnerapi-na.amazon.com' });
  const bad = fakeFetch();
  await assert.rejects(
    () => invoke({ slug: 'amazon_spapi', actionSlug: 'amazon-orders/get-orders', params: { region_host: 'attacker.example', marketplace_ids: 'ATVPDKIKX0DER' }, catalog: AMAZON_CATALOG, credential: cred }, bad.impl),
    (e) => e.status === 400 && /region_host/.test(e.message) && assertNoSecret(e),
  );
  // Even another legitimate region is refused — the connection's region is authoritative.
  await assert.rejects(
    () => invoke({ slug: 'amazon_spapi', actionSlug: 'amazon-orders/get-orders', params: { region_host: 'sellingpartnerapi-eu.amazon.com' }, catalog: AMAZON_CATALOG, credential: cred }, bad.impl),
    (e) => e.status === 400,
  );
  assert.equal(bad.calls.length, 0);
  for (const params of [{ marketplace_ids: 'X' }, { region_host: 'sellingpartnerapi-na.amazon.com', marketplace_ids: 'X' }]) {
    const { impl, calls } = fakeFetch();
    await invoke({ slug: 'amazon_spapi', actionSlug: 'amazon-orders/get-orders', params, catalog: AMAZON_CATALOG, credential: cred }, impl);
    assert.equal(calls[0].url, 'https://sellingpartnerapi-na.amazon.com/orders/v0/orders?MarketplaceIds=X');
    assert.equal(calls[0].opts.headers['x-amz-access-token'], 'Atza|SECRET');
  }
});

test('host-guard: the connection value also wins for QUERY and HEADER placeholders', () => {
  const q = def('t/q', 'GET', 'https://api.example.com/x?region={region}');
  assert.throws(() => assembleRequest(q, { region: 'us' }, 'T', { region: 'eu' }), (e) => e.status === 400 && /"region"/.test(e.message));
  assert.equal(assembleRequest(q, {}, 'T', { region: 'eu' }).url, 'https://api.example.com/x?region=eu');

  const h = def('t/h', 'GET', 'https://api.example.com/x', { headers_template: { 'X-Account': '{account_id}' } });
  assert.throws(() => assembleRequest(h, { account_id: 'other' }, 'T', { account_id: 'acct-1' }), (e) => e.status === 400);
  assert.equal(assembleRequest(h, {}, 'T', { account_id: 'acct-1' }).headers['X-Account'], 'acct-1');
});

test('host-guard: a url_placeholders key the action does not template stays an ordinary caller param', () => {
  const post = def('t/p', 'POST', 'https://api.example.com/x');
  const req = assembleRequest(post, { shop: 'whatever' }, 'T', { shop: 'acme.myshopify.com' });
  assert.deepEqual(req.body, { shop: 'whatever' });
});

// ---------------------------------------------------------------------------
//  2/3. caller-supplied host: static per-connector rules + origin check
// ---------------------------------------------------------------------------

test('host-guard Amazon before region_host is delivered: caller region_host=attacker.example → 403, zero requests', async () => {
  const { impl, calls } = fakeFetch();
  for (const region_host of ['attacker.example', 'sellingpartnerapi-xx.amazon.com', 'sellingpartnerapi-fe.amazon.com:8443', 'sellingpartnerapi-na.amazon.com.attacker.example']) {
    await assert.rejects(
      () => invoke({ slug: 'amazon_spapi', actionSlug: 'amazon-orders/get-orders', params: { region_host, marketplace_ids: 'X' }, catalog: AMAZON_CATALOG, credential: amazonCred() }, impl),
      (e) => e.status === 403 && e.code === 'direct_origin_refused' && assertNoSecret(e),
      `region_host ${region_host} must be refused`,
    );
  }
  assert.equal(calls.length, 0);
});

test('host-guard Amazon before region_host is delivered: a real regional endpoint is allowed (any case)', async () => {
  for (const [region_host, host] of [['sellingpartnerapi-fe.amazon.com', 'sellingpartnerapi-fe.amazon.com'], ['SellingPartnerAPI-EU.amazon.com', 'sellingpartnerapi-eu.amazon.com']]) {
    const { impl, calls } = fakeFetch();
    const out = await invoke({ slug: 'amazon_spapi', actionSlug: 'amazon-orders/get-orders', params: { region_host, marketplace_ids: 'X' }, catalog: AMAZON_CATALOG, credential: amazonCred() }, impl);
    assert.equal(out.status_code, 200);
    assert.equal(new URL(calls[0].url).host, host);
    assert.equal(calls[0].opts.headers['x-amz-access-token'], 'Atza|SECRET');
  }
});

test('host-guard Shopify credential without shop (older cache): caller shop must be a *.myshopify.com host', async () => {
  const bad = fakeFetch();
  for (const shop of ['attacker.example', 'acme.myshopify.com.attacker.example', 'acme.myshopify.com:444', '-x.myshopify.com']) {
    await assert.rejects(
      () => invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-orders/list', params: { shop }, catalog: SHOPIFY_CATALOG, credential: shopifyCred() }, bad.impl),
      (e) => (e.status === 403 || e.status === 400) && assertNoSecret(e),
      `shop ${shop} must be refused`,
    );
  }
  assert.equal(bad.calls.length, 0);
  const { impl, calls } = fakeFetch();
  await invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-orders/list', params: { shop: 'Acme-Store.myshopify.com' }, catalog: SHOPIFY_CATALOG, credential: shopifyCred() }, impl);
  assert.equal(new URL(calls[0].url).host, 'acme-store.myshopify.com');
});

test('host-guard: the static rule also checks a connection-delivered host (defense in depth)', async () => {
  const { impl, calls } = fakeFetch();
  await assert.rejects(
    () => invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-orders/list', params: {}, catalog: SHOPIFY_CATALOG, credential: shopifyCred({ shop: 'evil.example' }) }, impl),
    (e) => e.status === 403,
  );
  assert.equal(calls.length, 0);
});

test('host-guard: the slug falls back to the credential provider when the index entry has none', async () => {
  const { impl, calls } = fakeFetch();
  await assert.rejects(
    () => invoke({ slug: null, actionSlug: 'amazon-orders/get-orders', params: { region_host: 'attacker.example' }, catalog: AMAZON_CATALOG, credential: { ...amazonCred(), provider: 'amazon_spapi' } }, impl),
    (e) => e.status === 403,
  );
  assert.equal(calls.length, 0);
});

test('host-guard: static rules exist for shopify-oauth, shopify and amazon_spapi only', () => {
  assert.deepEqual(Object.keys(STATIC_HOST_RULES).sort(), ['amazon_spapi', 'shopify', 'shopify-oauth']);
});

test('host-guard: a caller cannot supply base_url when the connection lacks it (no absolute URL → 400, zero requests)', async () => {
  const JENKINS = def('jenkins/jobs', 'GET', '{base_url}/api/json');
  for (const base_url of ['attacker.example', 'https://attacker.example']) {
    const { impl, calls } = fakeFetch();
    await assert.rejects(
      () => invoke({ slug: 'jenkins', actionSlug: 'jenkins/jobs', params: { base_url }, catalog: [JENKINS], credential: { credential_mode: 'direct', token_type: 'api_key', access_token: 'K' } }, impl),
      (e) => e.status === 400 || e.status === 422,
    );
    assert.equal(calls.length, 0);
  }
});

// ---------------------------------------------------------------------------
//  Other connectors unaffected
// ---------------------------------------------------------------------------

test('host-guard unaffected: Jenkins base_url, Salesforce instance_url, DocuSign base_uri/account_id', async () => {
  const cases = [
    { slug: 'jenkins', d: def('jenkins/job', 'GET', '{base_url}/job/{name}/api/json'), uph: { base_url: 'https://ci.example.com:8443/jenkins' }, params: { name: 'build' }, url: 'https://ci.example.com:8443/jenkins/job/build/api/json' },
    { slug: 'salesforce', d: def('salesforce-sobjects/get', 'GET', '{instance_url}/services/data/v60.0/sobjects/{sobject}/{id}'), uph: { instance_url: 'https://acme.my.salesforce.com' }, params: { sobject: 'Account', id: '001' }, url: 'https://acme.my.salesforce.com/services/data/v60.0/sobjects/Account/001' },
    { slug: 'docusign', d: def('docusign-envelopes/list', 'GET', '{base_uri}/restapi/v2.1/accounts/{account_id}/envelopes'), uph: { base_uri: 'https://na3.docusign.net', account_id: 'acc-9' }, params: { account_id: 'acc-9' }, url: 'https://na3.docusign.net/restapi/v2.1/accounts/acc-9/envelopes' },
  ];
  for (const c of cases) {
    const { impl, calls } = fakeFetch();
    await invoke({ slug: c.slug, actionSlug: `${c.d.toolkit}/${c.d.action}`, params: c.params, catalog: [c.d], credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'T', url_placeholders: c.uph } }, impl);
    assert.equal(calls[0].url, c.url, c.slug);
  }
  // ...and a caller override of their connection-owned host part is refused.
  assert.throws(() => assembleRequest(cases[1].d, { instance_url: 'https://attacker.example', sobject: 'A', id: '1' }, 'T', cases[1].uph), (e) => e.status === 400);
  assert.throws(() => assembleRequest(cases[0].d, { base_url: 'https://attacker.example', name: 'b' }, 'T', cases[0].uph), (e) => e.status === 400);
});

test('host-guard unaffected: path params keep "/" (people/me) on a static host', async () => {
  const PEOPLE = def('google-people/get', 'GET', 'https://people.googleapis.com/v1/{resourceName}?personFields={personFields}');
  const { impl, calls } = fakeFetch();
  await invoke({ slug: 'google_people', actionSlug: 'google-people/get', params: { resourceName: 'people/me', personFields: 'names' }, catalog: [PEOPLE], credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'T' } }, impl);
  assert.equal(calls[0].url, 'https://people.googleapis.com/v1/people/me?personFields=names');
});

test('host-guard unaffected: a {tenant} subdomain connector without a static rule keeps working (authority chars still checked)', async () => {
  const TENANT = def('saas/items', 'GET', 'https://{tenant}.provider.example/v1/items');
  const { impl, calls } = fakeFetch();
  await invoke({ slug: 'some-saas', actionSlug: 'saas/items', params: { tenant: 'acme' }, catalog: [TENANT], credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'T' } }, impl);
  assert.equal(calls[0].url, 'https://acme.provider.example/v1/items');
  await assert.rejects(
    () => invoke({ slug: 'some-saas', actionSlug: 'saas/items', params: { tenant: 'attacker.example/x' }, catalog: [TENANT], credential: { credential_mode: 'direct', token_type: 'bearer', access_token: 'T' } }, impl),
    (e) => e.status === 400 && /authority/i.test(e.message),
  );
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------------------
//  request_spec path uses the same assembly
// ---------------------------------------------------------------------------

test('host-guard request_spec: the same override rule and static host rule apply', async () => {
  const SPEC_CREATE = def('shopify-products/create-spec', 'POST', 'https://{shop}/admin/api/2026-07/products.json', {
    request_spec: { version: 1, requires: ['body_template'], encoding: 'json', body: { product: { title: '{{title}}' } } },
  });
  const catalog = [SPEC_CREATE];
  const bad = fakeFetch();
  await assert.rejects(
    () => invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-products/create-spec', params: { shop: 'attacker.example', title: 'x' }, catalog, credential: shopifyCred({ shop: 'acme.myshopify.com' }) }, bad.impl),
    (e) => e.status === 400,
  );
  await assert.rejects(
    () => invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-products/create-spec', params: { shop: 'attacker.example', title: 'x' }, catalog, credential: shopifyCred() }, bad.impl),
    (e) => e.status === 403,
  );
  assert.equal(bad.calls.length, 0);
  const { impl, calls } = fakeFetch();
  await invoke({ slug: 'shopify-oauth', actionSlug: 'shopify-products/create-spec', params: { title: 'x' }, catalog, credential: shopifyCred({ shop: 'acme.myshopify.com' }) }, impl);
  assert.equal(calls[0].url, 'https://acme.myshopify.com/admin/api/2026-07/products.json');
  assert.deepEqual(JSON.parse(String(calls[0].opts.body)), { product: { title: 'x' } });
});
