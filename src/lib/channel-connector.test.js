import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isChannelEvent,
  normalizeAction,
  CHANNEL_COMPONENT,
  createChannelInstaller,
} from './channel-connector.js';

const apiPath = (p) => `/api/v1${p}`;

test('isChannelEvent: channel.* → true; other domains → false', () => {
  assert.equal(isChannelEvent('channel.connect'), true);
  assert.equal(isChannelEvent('channel.disconnect'), true);
  assert.equal(isChannelEvent('CHANNEL.CONNECT'), true); // case-insensitive
  assert.equal(isChannelEvent('connection.authorized'), false);
  assert.equal(isChannelEvent('message.updated'), false);
  assert.equal(isChannelEvent(''), false);
  assert.equal(isChannelEvent(undefined), false);
});

test('normalizeAction: connect/disconnect + legacy aliases', () => {
  assert.equal(normalizeAction('connect'), 'connect');
  assert.equal(normalizeAction('install'), 'connect');            // legacy
  assert.equal(normalizeAction('update-credentials'), 'connect'); // legacy
  assert.equal(normalizeAction('disconnect'), 'disconnect');
  assert.equal(normalizeAction('uninstall'), 'disconnect');       // legacy
  assert.equal(normalizeAction('CONNECT'), 'connect');
  assert.equal(normalizeAction('bogus'), 'bogus');
});

test('CHANNEL_COMPONENT.feishu.buildConfig: app_id/app_secret → .env (no dead FEISHU_IS_LARK), websocket → config.json', () => {
  const spec = CHANNEL_COMPONENT.feishu;
  assert.equal(spec.component, 'feishu');
  assert.equal(spec.pm2Service, 'zylos-feishu');

  const built = spec.buildConfig({ app_id: 'cli_abc', app_secret: 's3cr3t', extra: 'ignored' });
  assert.deepEqual(built.env, { FEISHU_APP_ID: 'cli_abc', FEISHU_APP_SECRET: 's3cr3t' });
  assert.deepEqual(built.configJson, { enabled: true, connection_mode: 'websocket' });

  // Accept alternate key spellings from cws-core.
  const built2 = spec.buildConfig({ appId: 'x', appSecret: 'y' });
  assert.equal(built2.env.FEISHU_APP_ID, 'x');
  assert.equal(built2.env.FEISHU_APP_SECRET, 'y');
});

const ORG = { slug: 'acme', org_id: 'org-1', self: { member_id: 'm-self' } };

function makeConnector({
  pullResp = { config: { app_id: 'aid', app_secret: 'asec' } },
  installed = false,      // whether `zylos info` reports feishu installed
  dedupeSeen = false,
  verify = true,          // injected verifyConnected result
} = {}) {
  const pulls = [];
  const execCalls = [];
  const envWrites = [];
  const configWrites = [];
  const reports = [];
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
    verifyConnected: async () => verify,
    reportResult: async (r) => reports.push(r),
    log: (m) => logs.push(m),
    warn: (m) => warns.push(m),
  });

  return { handle, pulls, execCalls, envWrites, configWrites, reports, warns, logs };
}

function frame(data) {
  return { payload: { event: `channel.${data.action}`, data } };
}

test('connect feishu (not installed): pulls, zylos add, writes .env + config, restarts, verifies, reports connected', async () => {
  const h = makeConnector({ installed: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-1',
    request_id: 'req-1', credential_pull_token: 'tok-1', agent_member_id: 'm-self',
  }));

  assert.equal(h.pulls.length, 1);
  assert.equal(h.pulls[0].path, '/api/v1/connect/channel-bindings/bind-1/credential');
  assert.deepEqual(h.pulls[0].extraHeaders, { 'X-Channel-Bind-Token': 'tok-1' });

  // not installed → add (not upgrade) → restart
  assert.deepEqual(h.execCalls[0], ['zylos', 'info', 'feishu', '--json']);
  assert.deepEqual(h.execCalls[1], ['zylos', 'add', 'feishu', '--yes']);
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'restart' && c[2] === 'zylos-feishu'));
  assert.ok(!h.execCalls.some((c) => c[1] === 'upgrade'));

  // secrets → .env (no dead FEISHU_IS_LARK), mode → config.json
  assert.deepEqual(h.envWrites, [{ FEISHU_APP_ID: 'aid', FEISHU_APP_SECRET: 'asec' }]);
  assert.deepEqual(h.configWrites, [{ component: 'feishu', patch: { enabled: true, connection_mode: 'websocket' } }]);

  // connect-result回执 = connected
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'connected');
  assert.equal(h.reports[0].bindingId, 'bind-1');
  assert.equal(h.reports[0].channelType, 'feishu');
  assert.equal(h.warns.length, 0);

  // Secret VALUES must never be logged (keys only).
  assert.ok(!h.logs.some((l) => l.includes('asec') || l.includes('aid')));
});

test('connect feishu (already installed): zylos upgrade (NOT add), reports connected', async () => {
  const h = makeConnector({ installed: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-2',
    request_id: 'req-2', credential_pull_token: 'tok-2',
  }));
  assert.deepEqual(h.execCalls[0], ['zylos', 'info', 'feishu', '--json']);
  assert.deepEqual(h.execCalls[1], ['zylos', 'upgrade', 'feishu', '--yes']);
  assert.ok(!h.execCalls.some((c) => c[1] === 'add'));
  assert.equal(h.reports[0].status, 'connected');
});

test('legacy action "install" is treated as connect', async () => {
  const h = makeConnector({ installed: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'install', binding_id: 'bind-2b', request_id: 'r', credential_pull_token: 't',
  }));
  assert.ok(h.execCalls.some((c) => c[1] === 'add'));
  assert.equal(h.reports[0].status, 'connected');
});

test('connect: verification fails → reports error (not a false connected)', async () => {
  const h = makeConnector({ installed: false, verify: false });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-3', request_id: 'req-3', credential_pull_token: 'tok-3',
  }));
  // work still happened (add + restart), but result is error
  assert.ok(h.execCalls.some((c) => c[1] === 'add'));
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].status, 'error');
});

test('disconnect: soft-disable (pm2 stop + enabled:false), keeps creds, NO uninstall', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'disconnect', binding_id: 'bind-4', request_id: 'req-4',
  }));
  assert.equal(h.pulls.length, 0);                                   // no cred pull on disconnect
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop' && c[2] === 'zylos-feishu'));
  assert.deepEqual(h.configWrites, [{ component: 'feishu', patch: { enabled: false } }]);
  assert.equal(h.envWrites.length, 0);                               // creds kept (no .env change)
  assert.ok(!h.execCalls.some((c) => c[0] === 'zylos' && (c[1] === 'uninstall' || c[1] === 'remove')));
  assert.equal(h.reports[0].status, 'disconnected');
});

test('legacy action "uninstall" → disconnect (soft-disable, not zylos uninstall)', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'uninstall', binding_id: 'bind-4b', request_id: 'r',
  }));
  assert.ok(h.execCalls.some((c) => c[0] === 'pm2' && c[1] === 'stop'));
  assert.ok(!h.execCalls.some((c) => c[1] === 'uninstall' || c[1] === 'remove'));
  assert.equal(h.reports[0].status, 'disconnected');
});

test('unsupported channel_type on connect: no pull, no shell-out, warns', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'discord', action: 'connect', binding_id: 'bind-5', request_id: 'req-5', credential_pull_token: 'tok-5',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.warns.length, 1);
  assert.match(h.warns[0], /not supported/);
});

test('event not for this agent: skipped entirely', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-6', request_id: 'req-6',
    credential_pull_token: 'tok-6', agent_member_id: 'someone-else',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.reports.length, 0);
});

test('dedup: redelivered command dropped before any work', async () => {
  const h = makeConnector({ dedupeSeen: true });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-7', request_id: 'req-7', credential_pull_token: 'tok-7',
  }));
  assert.equal(h.pulls.length, 0);
  assert.equal(h.execCalls.length, 0);
});

test('empty pulled config: reports error, does not install', async () => {
  const h = makeConnector({ pullResp: { config: {} } });
  await h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-8', request_id: 'req-8', credential_pull_token: 'tok-8',
  }));
  assert.equal(h.pulls.length, 1);
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.warns[0], /empty\/absent/);
});

test('credential pull failure: reports error, never throws, no install', async () => {
  const h = makeConnector({ pullResp: new Error('403 forbidden') });
  await assert.doesNotReject(h.handle(ORG, frame({
    channel_type: 'feishu', action: 'connect', binding_id: 'bind-9', request_id: 'req-9', credential_pull_token: 'bad',
  })));
  assert.equal(h.execCalls.length, 0);
  assert.equal(h.reports[0].status, 'error');
  assert.match(h.warns[0], /credential pull failed/);
});

test('missing binding_id: warns, no work', async () => {
  const h = makeConnector();
  await h.handle(ORG, frame({ channel_type: 'feishu', action: 'connect', request_id: 'r' }));
  assert.equal(h.pulls.length, 0);
  assert.match(h.warns[0], /missing binding_id/);
});
