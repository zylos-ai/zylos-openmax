import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { readDashboardProbe, evaluateDashboardReadiness } from './dashboard-readiness.js';
import { getDashboardPort } from './dashboard-address.js';
import { createDefaultReadinessGate, createReadinessGate, createGatedOnlineReporter, readinessReport } from './agent-readiness.js';

// Boundary: real HTTP client, private loopback server and existing Dashboard
// port config. Run for readiness HTTP/address/timeout changes; unrelated work
// may skip. Every case allocates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and passes
// only its private port/config to product code; the outer runner also isolates.
// No runtime, tmux or database starts; t.after closes all server connections.
async function fixture(t, respond) {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/omr-http-'));
  const env = { HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'home/zylos'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  let server;
  t.after(async () => {
    try {
      server?.closeAllConnections();
      if (server?.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    fs.mkdirSync(env[key], { recursive: true });
    assert.ok(fs.realpathSync(env[key]).startsWith(root + path.sep));
    assert.equal(env[key].startsWith(os.userInfo().homedir + path.sep), false);
  }
  t.diagnostic(JSON.stringify({ ...env, tmux: 'unused', database: 'unused' }));
  const requests = [];
  server = http.createServer((request, response) => { requests.push(request.url); respond(request, response); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, requests, env, server, root };
}

const payload = (overrides = {}) => ({ ready: true, reason: null, session_mode: 'multi', session_running: null,
  runtime_health: { claude: { source: 'record', health: 'ok' }, codex: { source: 'missing', health: null } }, ...overrides });

function wireCore(f, version = '1.0.0-beta.8') {
  const core = path.join(f.root, 'core');
  fs.mkdirSync(core);
  fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: 'zylos', version }));
  f.env.ZYLOS_PACKAGE_ROOT = core;
  for (const folder of ['.zylos', 'components/dashboard', 'activity-monitor']) fs.mkdirSync(path.join(f.env.ZYLOS_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), JSON.stringify({ runtime: 'claude' }));
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, 'components/dashboard/config.json'), JSON.stringify({ port: f.port }));
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, 'activity-monitor/agent-status.json'), JSON.stringify({ state: 'busy', health: 'auth_failed' }));
  return createDefaultReadinessGate({ env: f.env });
}

test('the existing Dashboard configured port serves the unauthenticated readiness request', async t => {
  const f = await fixture(t, (request, response) => {
    assert.equal(request.headers.authorization, undefined);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ ready: true }));
  });
  const config = path.join(f.env.HOME, 'zylos/components/dashboard/config.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ port: f.port }));
  assert.deepEqual(await readDashboardProbe({ port: getDashboardPort({ home: f.env.HOME }) }), { status: 200, body: { ready: true } });
  assert.deepEqual(f.requests, ['/api/health?probe=ready']);
});

test('a 503 readiness body is read without treating HTTP status as a transport error', async t => {
  const f = await fixture(t, (_request, response) => {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ready: false }));
  });
  assert.deepEqual(await readDashboardProbe({ port: f.port }), { status: 503, body: { ready: false } });
});

for (const mode of ['no-headers', 'incomplete-body']) {
  test(`a ${mode} response times out and releases the HTTP request`, { timeout: 3000 }, async t => {
    const f = await fixture(t, (_request, response) => {
      if (mode === 'incomplete-body') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.write('{');
      }
    });
    assert.equal(await readDashboardProbe({ port: f.port, timeoutMs: 30 }), null);
  });
}

test('default Core 1 wiring reports a sessionless multi instance ready and releases onboarding', async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload())));
  const gate = wireCore(f);
  assert.deepEqual(readinessReport(await gate.evaluate()), { ready: true, observable: true, stage: 'ready', reason: 'ready' });
  let reports = 0;
  const online = createGatedOnlineReporter({ gate, reportAgentOnline: async () => { reports++; } });
  await online({ slug: 'isolated-org' });
  assert.equal(reports, 1, 'multi mode needs no current-launch session file');
  assert.ok(f.requests.every(url => url === '/api/health?probe=ready'));
});

test('default Core 1 uses the Core Claude default when runtime is unset', async t => {
  const f = await fixture(t, (_request, response) => response.end(JSON.stringify(payload())));
  const gate = wireCore(f);
  fs.writeFileSync(path.join(f.env.ZYLOS_DIR, '.zylos/config.json'), '{}');
  const v = await gate.evaluate();
  assert.equal(v.ready, true);
  assert.equal(v.onboardingReason, undefined);
  assert.equal(v.detail.runtime, 'claude');
});

test('default Core 0 wiring retains file readiness and never requests Dashboard', async t => {
  const f = await fixture(t, () => { throw new Error('legacy Core must not request HTTP'); });
  const gate = wireCore(f, '0.9.9');
  const result = gate.evaluate();
  assert.equal(result.reason, 'health_auth_failed');
  assert.equal(result.ready, false);
  assert.equal(f.requests.length, 0);
});

test('default Core 1 connection failure never falls back to legacy status', async t => {
  const f = await fixture(t, (_request, response) => response.end('{}'));
  const gate = wireCore(f);
  await new Promise(resolve => f.server.close(resolve));
  const result = await gate.evaluate();
  assert.deepEqual(readinessReport(result), { ready: false, observable: false, stage: 'runtime_down', reason: 'dashboard_unavailable' });
});

for (const [reason, stage] of [['supervisor_unavailable', 'runtime_down'], ['session_not_running', 'runtime_up']]) {
  test(`default Core 1 maps ${reason} to ${stage}`, async t => {
    const f = await fixture(t, (_request, response) => {
      response.statusCode = 503;
      response.end(JSON.stringify(payload({ ready: false, reason, session_mode: 'single', session_running: false })));
    });
    assert.deepEqual(readinessReport(await wireCore(f).evaluate()), { ready: false, observable: false, stage, reason });
  });
}

for (const runtime of ['claude', 'codex']) for (const health of ['ok', 'auth_failed', 'down', 'unavailable', 'rate_limited', 'recovering']) {
  test(`${runtime} ${health}: availability stays ready and only selected health defers onboarding`, async () => {
    const data = payload({ runtime_health: {
      [runtime]: { source: 'record', health },
      [runtime === 'claude' ? 'codex' : 'claude']: { source: 'record', health: 'auth_failed' },
    } });
    const v = await evaluateDashboardReadiness({ runtime, readProbe: async () => ({ status: 200, body: data }) });
    assert.deepEqual(readinessReport(v), { ready: true, observable: true, stage: 'ready', reason: 'ready' });
    assert.equal(v.onboardingReason, ['auth_failed', 'down', 'unavailable'].includes(health) ? `health_${health}` : undefined);
  });
}

for (const source of ['missing', 'unreadable']) {
  test(`${source} health stays unknown without inventing login history`, async () => {
    const v = await evaluateDashboardReadiness({ runtime: 'claude',
      readProbe: async () => ({ status: 200, body: payload({ runtime_health: { claude: { source, health: null } } }) }) });
    assert.equal(v.ready, true);
    assert.equal(v.detail.health, null);
    assert.equal(v.detail.health_source, source);
    assert.equal(v.onboardingReason, 'health_unknown');
  });
}

for (const probe of [null, { status: 500, body: {} }, { status: 200, body: {} }, { status: 200, body: { ready: false } },
  { status: 503, body: { ready: false, reason: 'unknown' } }]) {
  test(`an invalid or unavailable probe is not ready (${JSON.stringify(probe)})`, async () => {
    const v = await evaluateDashboardReadiness({ readProbe: async () => probe });
    assert.equal(v.ready, false);
    assert.equal(readinessReport(v).stage, 'runtime_down');
  });
}

for (const [body, status, failOpen] of [
  [payload({ runtime_health: { claude: { source: 'record', health: 'down' } } }), 200, true],
  [payload({ runtime_health: { claude: { source: 'missing', health: null } } }), 200, true],
  [payload({ ready: false, reason: 'session_not_running', session_mode: 'single', session_running: false }), 503, false],
]) {
  test(`onboarding cap preserves ${failOpen ? 'fail-open for runtime health' : 'the single missing-session hold'} (${body.runtime_health.claude.source})`, async () => {
    let now = 0, reports = 0;
    const gate = createReadinessGate({ readCoreVersion: () => '1.0.0',
      readDashboardReadiness: () => evaluateDashboardReadiness({ runtime: 'claude', readProbe: async () => ({ status, body }) }),
      now: () => now, sleep: async ms => { now += ms; }, options: () => ({ maxWaitMs: 5, pollMs: 2 }) });
    const result = await gate.waitUntilReady();
    assert.equal(result.timedOut, true);
    assert.equal(result.failOpenAllowed, failOpen);
    const online = createGatedOnlineReporter({ gate, reportAgentOnline: async () => { reports++; } });
    await online({ slug: 'isolated-org' });
    assert.equal(reports, failOpen ? 1 : 0);
  });
}
