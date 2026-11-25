import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createComputerRemoteConnector,
  createComputerRemoteLocalClient,
  isComputerRemoteCommand,
} from './computer-remote-connector.js';

const orgId = '11111111-1111-1111-1111-111111111111';
const memberId = '22222222-2222-2222-2222-222222222222';
const bindingId = '33333333-3333-3333-3333-333333333333';
const requestId = '44444444-4444-4444-4444-444444444444';
const deviceId = '55555555-5555-5555-5555-555555555555';
const epoch = Date.UTC(2026, 0, 1);
const expiresAt = new Date(epoch + 60_000).toISOString();
const ticket = 'ticket_that_must_not_appear_in_any_log_output';
const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  .publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const org = { org_id: orgId, slug: 'test-org', self: { member_id: memberId } };
const meta = { slug: org.slug, orgId, memberId, bindingId, requestId };
const frameFor = (action, extra = {}) => ({
  payload: { event: 'channel.install', data: {
    channel_type: 'computer-remote', org_id: orgId, agent_member_id: memberId,
    action, binding_id: bindingId, request_id: requestId, ...extra,
  } },
});
const local = '/v1/workspace-enrollment';
const core = `/api/v1/connect/computer-use/connections/${bindingId}`;
const ids = { connection_id: bindingId, request_id: requestId };

function fixture(overrides = {}) {
  const calls = { get: [], post: [], remote: [], exec: [], queue: [], fetch: [], log: [] };
  const connector = createComputerRemoteConnector({
    apiPath: (route) => `/api/v1${route}`,
    now: () => epoch,
    wait: async () => {},
    resolvePublicBase: async () => 'https://agent.example.test',
    getForOrg: async (...args) => {
      calls.get.push(args);
      return { data: { ...ids, agent_member_id: memberId, public_key: publicKey, device_name: 'Test Mac' } };
    },
    postForOrg: async (...args) => { calls.post.push(args); },
    persistConnectedCheck: (entry) => { calls.queue.push(entry); return true; },
    fetchImpl: async (...args) => {
      calls.fetch.push(args);
      return Response.json({ error: 'upgrade_required' }, { status: 426 });
    },
    execFile: async (file, args) => {
      calls.exec.push([file, args]);
      if (args[0] === 'info') {
        return { stdout: JSON.stringify({
          name: 'computer-remote', service: { name: 'zylos-computer-remote', status: 'online' },
        }) };
      }
    },
    remote: async (...args) => {
      calls.remote.push(args);
      if (args[1] === '/v1/health') return { ok: true };
      if (args[1] === local) return { ticket, expires_at: expiresAt };
      if (args[1] === `${local}/revoke`) return { revoked: true };
      return { state: 'paired', online: true, device_id: deviceId };
    },
    log: (message) => calls.log.push(message),
    warn: (message) => calls.log.push(message),
    ...overrides,
  });
  return { connector, calls };
}

test('reuses a healthy Remote, verifies the public route, and reports a credential only after saving receipt metadata', async () => {
  const { connector, calls } = fixture();
  assert.equal(isComputerRemoteCommand(frameFor('prepare').payload.data), true);
  assert.equal(isComputerRemoteCommand({ channel_type: 'browser-remote' }), false);
  await connector.handleCommand(org, frameFor('prepare'));

  assert.deepEqual(calls.get.map(([org, route, query]) => [org, route, query]), Array(3).fill(
    [orgId, `${core}/prepare-input`, { request_id: requestId }],
  ));
  assert.deepEqual(calls.exec, [['zylos', ['info', 'computer-remote', '--json']]]);
  assert.equal(calls.fetch[0][0], 'https://agent.example.test/computer-remote/device/v1/ws');
  assert.equal(calls.fetch[0][1].redirect, 'error');
  assert.deepEqual(calls.remote, [
    ['GET', '/v1/health'],
    ['POST', local, { ...ids, public_key: publicKey, device_name: 'Test Mac' }],
  ]);
  assert.deepEqual(calls.queue, [{ ...meta, kind: 'computer-connected', status: 'pending' }]);
  assert.deepEqual(calls.post[0].slice(0, 3), [orgId, `${core}/prepare-result`, {
    request_id: requestId, ok: true, remote_url: 'https://agent.example.test/computer-remote',
    ticket, expires_at: expiresAt,
  }]);
  assert.equal(calls.post[0][3].sensitiveBody, true);
  assert.ok(!JSON.stringify(calls.log).includes(ticket));
  assert.ok(!JSON.stringify(calls.queue).includes(ticket));
});

test('installs a missing Remote once for concurrent valid requests', async () => {
  const installed = [];
  let unblock;
  const installBarrier = new Promise((resolve) => { unblock = resolve; });
  const otherBinding = '66666666-6666-6666-6666-666666666666';
  const { connector } = fixture({
    getForOrg: async (_org, route) => ({
      ...ids, connection_id: route.split('/').at(-2), agent_member_id: memberId,
      public_key: publicKey, device_name: 'Test Mac',
    }),
    execFile: async (file, args) => {
      if (args[0] === 'info') {
        throw Object.assign(new Error('not installed'), { stderr: 'Error: Component "computer-remote" is not installed.' });
      }
      installed.push([file, args]);
      return installBarrier;
    },
  });
  const first = connector.handleCommand(org, frameFor('prepare'));
  const second = connector.handleCommand(org, frameFor('prepare', { binding_id: otherBinding }));
  await new Promise(setImmediate);
  assert.deepEqual(installed, [['zylos', ['add', 'computer-remote', '--yes']]]);
  unblock();
  await Promise.all([first, second]);
});

test('a wrong target, stale command, or differently scoped Core response cannot install or revoke', async () => {
  const stale = Object.assign(new Error('stale'), { status: 409 });
  const { connector, calls } = fixture({
    getForOrg: async (_org, route) => {
      if (route.endsWith('/revoke-input')) {
        return { ...ids, agent_member_id: deviceId };
      }
      throw stale;
    },
  });
  await connector.handleCommand(org, frameFor('prepare', { org_id: deviceId }));
  await connector.handleCommand(org, frameFor('prepare', { agent_member_id: deviceId }));
  await connector.handleCommand(org, frameFor('prepare'));
  await connector.handleCommand(org, frameFor('revoke'));
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.remote, []);
  assert.deepEqual(calls.post, []);
});

test('a superseded prepare result discards only the matching pending Remote enrollment', async () => {
  const calls = [];
  const { connector } = fixture({
    postForOrg: async () => { throw Object.assign(new Error(ticket), { status: 409 }); },
    remote: async (method, route, body) => {
      calls.push([method, route, body]);
      if (route === '/v1/health') return { ok: true };
      if (route === local) return { ticket, expires_at: expiresAt };
      return { discarded: true };
    },
  });
  await connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(calls.at(-1), ['POST', `${local}/discard`, ids]);
  assert.ok(!calls.some(([, route]) => route === `${local}/revoke`));
});

test('a missed prepare reply preserves metadata and leaves the same ticket available for idempotent retry', async () => {
  const { connector, calls } = fixture({
    postForOrg: async () => { throw new Error('response lost'); },
  });
  await connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(calls.queue, [{ ...meta, kind: 'computer-connected', status: 'pending' }]);
  assert.ok(!calls.remote.some(([, route]) => route === `${local}/discard`));
});

test('an HTTPS route failure or queue persistence failure never gives Core a ticket', async () => {
  const insecure = fixture({ resolvePublicBase: async () => 'http://agent.example.test' });
  await insecure.connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(insecure.calls.post[0][2], { request_id: requestId, ok: false, error: 'public_url_unavailable' });
  assert.deepEqual(insecure.calls.exec, []);

  const storage = fixture({ persistConnectedCheck: () => false });
  await storage.connector.handleCommand(org, frameFor('prepare'));
  assert.deepEqual(storage.calls.remote.at(-1), ['POST', `${local}/discard`, ids]);
  assert.deepEqual(storage.calls.post[0][2], { request_id: requestId, ok: false, error: 'receipt_storage_unavailable' });
});

test('connected reports require paired state and a live Remote observation', async () => {
  const states = [
    { state: 'pending' },
    { state: 'paired', online: 'true', device_id: deviceId },
    { state: 'paired', online: false, device_id: deviceId },
    { state: 'paired', online: true, device_id: deviceId },
  ];
  const { connector, calls } = fixture({ remote: async () => states.shift() });
  for (let i = 0; i < 3; i++) await assert.rejects(connector.verifyConnected(meta), /Waiting for a verified/);
  assert.deepEqual(calls.post, []);
  await connector.verifyConnected(meta);
  assert.deepEqual(calls.post[0].slice(0, 3), [
    orgId, `${core}/connected`, { request_id: requestId, device_id: deviceId },
  ]);
});

test('revoke must be authorized by Core and acknowledged by Remote before sending a completion', async () => {
  const { connector, calls } = fixture();
  await connector.handleCommand(org, frameFor('revoke'));
  assert.equal(calls.get[0][1], `${core}/revoke-input`);
  assert.deepEqual(calls.exec, []);
  assert.deepEqual(calls.remote, [['POST', `${local}/revoke`, ids]]);
  assert.deepEqual(calls.post[0].slice(0, 3), [orgId, `${core}/revoke-ack`, { request_id: requestId }]);
});

test('the local client authenticates only to the recorded private loopback port and refuses a symlink token', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openmax-computer-remote-test-'));
  const token = 'a'.repeat(43);
  fs.writeFileSync(path.join(dir, 'agent.token'), token, { mode: 0o600 });
  const server = http.createServer((req, res) => {
    assert.equal(req.headers['x-computer-remote-token'], token);
    assert.equal(req.url, '/v1/health');
    res.end(JSON.stringify({ ok: true }));
  });
  t.after(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  fs.writeFileSync(path.join(dir, 'agent.port'), String(server.address().port), { mode: 0o600 });
  const remote = createComputerRemoteLocalClient({ dataDir: dir });
  assert.deepEqual(await remote('GET', '/v1/health'), { ok: true });
  fs.renameSync(path.join(dir, 'agent.token'), path.join(dir, 'renamed'));
  fs.symlinkSync(path.join(dir, 'renamed'), path.join(dir, 'agent.token'));
  await assert.rejects(remote('GET', '/v1/health'));
});
