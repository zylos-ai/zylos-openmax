import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChannelEvent,
  CHANNEL_COMPONENT,
  createChannelInstaller,
} from './channel-connector.js';

const apiPath = (p) => `/api/v1${p}`;

// classifySystemEvent (in comm-bridge) delegates the `channel.` decision to
// this predicate, so testing it here covers the classification contract.
test('isChannelEvent: channel.* → true; other domains → false', () => {
  assert.equal(isChannelEvent('channel.install'), true);
  assert.equal(isChannelEvent('channel.update-credentials'), true);
  assert.equal(isChannelEvent('channel.uninstall'), true);
  assert.equal(isChannelEvent('CHANNEL.INSTALL'), true); // case-insensitive
  assert.equal(isChannelEvent('connection.authorized'), false);
  assert.equal(isChannelEvent('message.updated'), false);
  assert.equal(isChannelEvent(''), false);
  assert.equal(isChannelEvent(undefined), false);
});

test('CHANNEL_COMPONENT.feishu.buildConfig: maps app_id/app_secret → .env, websocket → config.json', () => {
  const spec = CHANNEL_COMPONENT.feishu;
  assert.equal(spec.component, 'feishu');
  assert.equal(spec.pm2Service, 'zylos-feishu');

  const built = spec.buildConfig({ app_id: 'cli_abc', app_secret: 's3cr3t', extra: 'ignored' });
  assert.deepEqual(built.env, { FEISHU_IS_LARK: 'N', FEISHU_APP_ID: 'cli_abc', FEISHU_APP_SECRET: 's3cr3t' });
  assert.deepEqual(built.configJson, { enabled: true, connection_mode: 'websocket' });

  // Accept alternate key spellings from cws-core.
  const built2 = spec.buildConfig({ appId: 'x', appSecret: 'y' });
  assert.equal(built2.env.FEISHU_APP_ID, 'x');
  assert.equal(built2.env.FEISHU_APP_SECRET, 'y');
});

test('Phase 1: only feishu is wired up', () => {
  assert.ok(CHANNEL_COMPONENT.feishu);
  for (const other of ['slack', 'discord', 'whatsapp', 'line', 'telegram', 'lark']) {
    assert.equal(CHANNEL_COMPONENT[other], undefined, `${other} must not be wired up in Phase 1`);
  }
});

const ORG = { slug: 'acme', org_id: 'org-1', self: { member_id: 'm-self' } };

function makeInstaller({
  pullResp = { config: { app_id: 'aid', app_secret: 'asec' } },
  installed = false,           // whether `zylos info` reports feishu installed
  dedupeSeen = false,
} = {}) {
  const pulls = [];
  const execCalls = [];
  const envWrites = [];
  const configWrites = [];
  const warns = [];
  const logs = [];

  const getForOrgWithHeaders = async (orgId, path, extraHeaders) => {
    pulls.push({ orgId, path, extraHeaders });
    if (pullResp instanceof Error) throw pullResp;
    return pullResp;
  };
  const execFile = async (file, args) => {
    execCalls.push([file, ...args]);
    if (file === 'zylos' && args[0] === 'info') {
      if (installed) return { stdout: JSON.stringify({ name: 'feishu' }) };
      throw new Error('component not installed');
    }
    return { stdout: '' };
  };

  const handle = createChannelInstaller({
    getForOrgWithHeaders,
    apiPath,
    dedupe: () => dedupeSeen,
    execFile,
    writeEnv: (vars) => envWrites.push(vars),
    writeConfig: (component, patch) => configWrites.push({ component, patch }),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });

  return { handle, pulls, execCalls, envWrites, configWrites, warns, logs };
}

function frame(data) {
  return { payload: { event: `channel.${data.action}`, data } };
}

test('install feishu (not yet installed): pulls with bind token, installs, writes .env + config, restarts', async () => {
  const h = makeInstaller({ installed: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-1',
    request_id: 'req-1', credential_pull_token: 'tok-1', agent_member_id: 'm-self',
  }));

  // Pull URL + header
  assert.equal(h.pulls.length, 1);
  assert.equal(h.pulls[0].orgId, 'org-1');
  assert.equal(h.pulls[0].path, '/api/v1/connect/channel-bindings/bind-1/credential');
  assert.deepEqual(h.pulls[0].extraHeaders, { 'X-Channel-Bind-Token': 'tok-1' });

  // Install because `zylos info` said not installed
  assert.deepEqual(h.execCalls[0], ['zylos', 'info', 'feishu', '--json']);
  assert.deepEqual(h.execCalls[1], ['zylos', 'add', 'feishu', '--yes']);
  assert.deepEqual(h.execCalls[2], ['pm2', 'restart', 'zylos-feishu', '--update-env']);

  // Secrets → .env, connection mode → config.json
  assert.deepEqual(h.envWrites, [{ FEISHU_IS_LARK: 'N', FEISHU_APP_ID: 'aid', FEISHU_APP_SECRET: 'asec' }]);
  assert.deepEqual(h.configWrites, [{ component: 'feishu', patch: { enabled: true, connection_mode: 'websocket' } }]);
  assert.equal(h.warns.length, 0);

  // Secret VALUES must never be logged (keys only).
  assert.ok(!h.logs.some((l) => l.includes('asec') || l.includes('aid')));
});

test('update-credentials (already installed): skips `zylos add`, re-writes creds + restarts', async () => {
  const h = makeInstaller({ installed: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'update-credentials', binding_id: 'bind-2',
    request_id: 'req-2', credential_pull_token: 'tok-2',
  }));
  assert.equal(h.pulls.length, 1);
  assert.ok(!h.execCalls.some((c) => c[1] === 'add'));
  assert.deepEqual(h.envWrites.length, 1);
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'restart'));
});

test('unsupported channel_type: no pull, no shell-out, warns', async () => {
  const h = makeInstaller();
  await h.handle(ORG, frame({
    channel_type: 'slack', action: 'install', binding_id: 'bind-3', request_id: 'req-3',
    credential_pull_token: 'tok-3',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.envWrites.length, 0);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /not yet supported/);
});

test('event not for this agent: skipped entirely', async () => {
  const h = makeInstaller();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-4', request_id: 'req-4',
    credential_pull_token: 'tok-4', agent_member_id: 'someone-else',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
});

test('dedup: redelivered command is dropped before any work', async () => {
  const h = makeInstaller({ dedupeSeen: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-5', request_id: 'req-5',
    credential_pull_token: 'tok-5',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
});

test('empty pulled config: warns and does not install', async () => {
  const h = makeInstaller({ pullResp: { config: {} } });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-6', request_id: 'req-6',
    credential_pull_token: 'tok-6',
  }));
  assert.equal(h.pulls.length, 1);
  assert.equal(h.execCalls.length, 0);
  assert.match(h.warns[0], /empty\/absent/);
});

test('credential pull failure: warns, never throws, no install', async () => {
  const h = makeInstaller({ pullResp: new Error('403 forbidden') });
  await assert.doesNotReject(h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-7', request_id: 'req-7',
    credential_pull_token: 'bad',
  })));
  assert.equal(h.execCalls.length, 0);
  assert.match(h.warns[0], /credential pull failed/);
});

test('uninstall: best-effort `zylos uninstall`', async () => {
  const h = makeInstaller();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'uninstall', binding_id: 'bind-8', request_id: 'req-8',
  }));
  assert.equal(h.pulls.length, 0);
  assert.deepEqual(h.execCalls[0], ['zylos', 'uninstall', 'feishu', '--force']);
});

test('missing binding_id: warns, no work', async () => {
  const h = makeInstaller();
  await h.handle(ORG, frame({ channel_type: 'feishu', action: 'install', request_id: 'r' }));
  assert.equal(h.pulls.length, 0);
  assert.match(h.warns[0], /missing binding_id/);
});
