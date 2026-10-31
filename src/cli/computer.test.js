import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { normalizeAction, buildBatchParams, interpretExecute, devicesFromList } from './computer.js';

const cliPath = fileURLToPath(new URL('./computer.js', import.meta.url));
// Valid 1x1 PNG (same bytes cws-connect's devicesim returns).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// --- pure helpers ------------------------------------------------------------

test('normalizeAction: wire shapes pass through, Claude computer-tool shapes are mapped', () => {
  assert.deepEqual(normalizeAction({ type: 'click', x: 10.4, y: 20 }), { type: 'click', x: 10, y: 20, button: 'left' });
  assert.deepEqual(normalizeAction({ action: 'right_click', coordinate: [5, 6] }), { type: 'click', x: 5, y: 6, button: 'right' });
  assert.deepEqual(normalizeAction({ action: 'left_click_drag', start_coordinate: [1, 2], coordinate: [3, 4] }),
    { type: 'drag', path: [{ x: 1, y: 2 }, { x: 3, y: 4 }] });
  assert.deepEqual(normalizeAction({ action: 'key', text: 'super+Shift+S' }), { type: 'keypress', keys: ['cmd', 'shift', 's'] });
  assert.deepEqual(normalizeAction({ action: 'scroll', coordinate: [100, 200], scroll_direction: 'up', scroll_amount: 5 }),
    { type: 'scroll', x: 100, y: 200, scroll_x: 0, scroll_y: -5 });
  assert.deepEqual(normalizeAction({ action: 'wait', duration: 1.5 }), { type: 'wait', ms: 1500 });
  assert.throws(() => normalizeAction({ type: 'wait', ms: 6000 }), /0\.\.5000/);
  assert.throws(() => normalizeAction({ type: 'click' }), /needs x,y/);
  assert.throws(() => normalizeAction({ type: 'triple_click', x: 1, y: 1 }), /unsupported/);
});

test('buildBatchParams: 1..10 actions, optional fields only when set', () => {
  assert.throws(() => buildBatchParams({ actions: [] }), /non-empty/);
  assert.throws(() => buildBatchParams({ actions: Array(11).fill({ type: 'screenshot' }) }), /at most 10/);
  assert.deepEqual(buildBatchParams({ actions: [{ type: 'type', text: 'hi' }], task_hint: 'x' }),
    { actions: [{ type: 'type', text: 'hi' }], task_hint: 'x' });
});

test('interpretExecute: maps every gateway / device status to ok + guidance', () => {
  const cases = [
    [403, { status: 'needs_app_grant', executed: 0 }, 'needs_app_grant'],
    [403, { status: 'denied_by_user', executed: 1 }, 'denied_by_user'],
    [403, { status: 'blocked_by_policy' }, 'blocked_by_policy'],
    [500, { status: 'paused' }, 'paused'],
    [500, { status: 'error', error: { code: 'ax', message: 'boom' } }, 'error'],
    [503, { error: 'device_offline' }, 'device_offline'],
    [504, { error: 'device_timeout' }, 'device_timeout'],
    [429, { error: 'rate_limited' }, 'rate_limited'],
    [400, { error: 'invalid_actions', message: 'actions[0].type' }, 'invalid_actions'],
  ];
  for (const [code, body, status] of cases) {
    const r = interpretExecute({ status_code: code, body }, { save: () => assert.fail('no screenshot') });
    assert.equal(r.ok, false, status);
    assert.equal(r.status_code, code);
    assert.equal(r.status, status);
    assert.ok(r.agent_instruction && r.agent_instruction.length > 10, status);
  }
  const ok = interpretExecute({ status_code: 200, body: JSON.stringify({ status: 'ok', executed: 1 }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.agent_instruction, undefined);
});

test('devicesFromList: only device connections (slug desktop-macos or connector_kind device)', () => {
  const d = devicesFromList([
    { id: 'c-gmail', application_slug: 'gmail', status: 'active' },
    { id: 'c-mac', application_slug: 'desktop-macos', display_name: 'Work Mac', status: 'active' },
    { id: 'c-mac2', connector_kind: 'device', status: 'pending' },
  ]);
  assert.deepEqual(d.map((x) => x.device_id), ['c-mac', 'c-mac2']);
  assert.equal(d[0].name, 'Work Mac');
});

// --- CLI against a stubbed cws-core ------------------------------------------

function setupHome(orgId = 'org-1') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'computer-home-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(compDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: { [orgId]: { enabled: true, org_id: orgId, self: { member_id: 'm-self' } } },
  }));
  return home;
}

// Stub core: records every request; `execute(body)` returns the {status_code, body} data.
async function withCore({ connections = [], execute }, fn) {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      const env = (data) => res.end(JSON.stringify({ data, request_id: 'r', server_time: 't' }));
      if (req.method === 'GET' && req.url === '/api/v1/connect/agents/me/connections') return env(connections);
      if (req.method === 'POST' && /\/actions\/execute$/.test(req.url)) return env(execute(body));
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`, seen); } finally { server.close(); }
}

function run(home, apiUrl, args, extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HOME: home, COCO_API_URL: apiUrl, COCO_AUTH_TOKEN: 'test-token', OPENMAX_COMPUTER_SHOT_DIR: path.join(home, 'shots'), ...extraEnv },
    }, (error, stdout, stderr) => resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr }));
  });
}

const MAC = { id: 'dev-1', application_slug: 'desktop-macos', display_name: 'Mac', status: 'active' };

test('CLI screenshot: auto-picks the only Mac, posts computer.batch[screenshot], writes PNG, prints path + size', async () => {
  const home = setupHome();
  await withCore({
    connections: [{ id: 'c-gmail', application_slug: 'gmail', status: 'active' }, MAC],
    execute: () => ({ status_code: 200, body: { call_id: 'call-1', status: 'ok', executed: 1, frontmost_app: 'com.apple.finder',
      screenshot: { mime: 'image/png', b64: PNG_B64, width: 1, height: 1, scale: 1, app: 'com.apple.finder' } } }),
  }, async (url, seen) => {
    const { code, stdout, stderr } = await run(home, url, ['screenshot', '{"task_hint":"look"}']);
    assert.equal(code, 0, stderr);
    const exec = seen.find((s) => s.method === 'POST');
    assert.equal(exec.url, '/api/v1/connect/connections/dev-1/actions/execute');
    assert.equal(exec.auth, 'Bearer test-token');
    assert.deepEqual(exec.body, { action: 'computer.batch', params: { actions: [{ type: 'screenshot' }], task_hint: 'look' } });
    const out = JSON.parse(stdout);
    assert.equal(out.ok, true);
    assert.equal(out.device_id, 'dev-1');
    assert.equal(out.screenshot.width, 1);
    assert.equal(out.screenshot.height, 1);
    assert.match(out.screenshot.path, /call-1\.png$/);
    assert.deepEqual(fs.readFileSync(out.screenshot.path), Buffer.from(PNG_B64, 'base64'));
    assert.equal(fs.statSync(out.screenshot.path).mode & 0o777, 0o600);
    assert.ok(!stdout.includes(PNG_B64), 'base64 must never be printed');
  });
});

test('CLI act: explicit device, Claude-style click normalized into the request body; no list call', async () => {
  const home = setupHome();
  await withCore({
    execute: () => ({ status_code: 200, body: { call_id: 'c2', status: 'ok', executed: 2, frontmost_app: 'com.apple.Safari' } }),
  }, async (url, seen) => {
    const { code, stdout, stderr } = await run(home, url, ['computer.act', JSON.stringify({
      device: 'dev-9', target_app: 'com.apple.Safari',
      actions: [{ action: 'left_click', coordinate: [120, 340] }, { type: 'type', text: 'hello' }],
    })]);
    assert.equal(code, 0, stderr);
    assert.deepEqual(seen.map((s) => s.url), ['/api/v1/connect/connections/dev-9/actions/execute']);
    assert.deepEqual(seen[0].body, { action: 'computer.batch', params: {
      actions: [{ type: 'click', x: 120, y: 340, button: 'left' }, { type: 'type', text: 'hello' }],
      target_app: 'com.apple.Safari',
    } });
    assert.deepEqual(JSON.parse(stdout), { device_id: 'dev-9', ok: true, status_code: 200, status: 'ok', executed: 2, frontmost_app: 'com.apple.Safari' });
  });
});

test('CLI act: device status 403 needs_app_grant → exit 2, structured result with guidance', async () => {
  const home = setupHome();
  await withCore({ connections: [MAC], execute: () => ({ status_code: 403, body: { call_id: 'c3', status: 'needs_app_grant', executed: 0 } }) },
    async (url) => {
      const { code, stdout } = await run(home, url, ['act', '{"actions":[{"type":"click","x":1,"y":1}]}']);
      assert.equal(code, 2);
      const out = JSON.parse(stdout);
      assert.equal(out.status, 'needs_app_grant');
      assert.match(out.agent_instruction, /authorized/);
    });
});

test('CLI act: invalid batch rejected locally before any network call', async () => {
  const home = setupHome();
  await withCore({ execute: () => assert.fail('must not execute') }, async (url, seen) => {
    const { code, stderr } = await run(home, url, ['act', '{"device":"d","actions":[{"type":"wait","ms":9000}]}']);
    assert.equal(code, 1);
    assert.equal(JSON.parse(stderr).status, 400);
    assert.equal(seen.length, 0);
  });
});

test('CLI apps: computer.list_apps, returns apps; 503 offline maps to device_offline', async () => {
  const home = setupHome();
  let offline = false;
  await withCore({ connections: [MAC], execute: () => (offline
    ? { status_code: 503, body: { error: 'device_offline' } }
    : { status_code: 200, body: { call_id: 'c4', status: 'ok', executed: 1, apps: [{ bundle_id: 'com.apple.finder', name: 'Finder', granted: true }] } }) },
  async (url, seen) => {
    let r = await run(home, url, ['apps']);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(seen.find((s) => s.method === 'POST').body, { action: 'computer.list_apps', params: {} });
    assert.equal(JSON.parse(r.stdout).apps[0].bundle_id, 'com.apple.finder');
    offline = true;
    r = await run(home, url, ['apps']);
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).status, 'device_offline');
  });
});

test('CLI: several Macs and no device → needs_selection error listing them', async () => {
  const home = setupHome();
  await withCore({ connections: [MAC, { ...MAC, id: 'dev-2', display_name: 'Home' }], execute: () => assert.fail() }, async (url) => {
    const { code, stderr } = await run(home, url, ['screenshot']);
    assert.equal(code, 1);
    const e = JSON.parse(stderr);
    assert.equal(e.code, 'needs_selection');
    assert.match(e.error, /dev-2/);
  });
});

test('RPC log file sink never contains screenshot base64 or typed text', async () => {
  const home = setupHome();
  const logFile = path.join(home, 'rpc.log');
  await withCore({ connections: [MAC], execute: () => ({ status_code: 200, body: { call_id: 'c5', status: 'ok', executed: 1,
    screenshot: { mime: 'image/png', b64: PNG_B64, width: 1, height: 1, scale: 1 } } }) },
  async (url) => {
    const r = await run(home, url, ['act', '{"actions":[{"type":"type","text":"s3cret-typed"}]}'], { COCO_RPC_LOG_FILE: logFile });
    assert.equal(r.code, 0, r.stderr);
    const log = fs.readFileSync(logFile, 'utf8');
    assert.match(log, /actions\/execute/);
    assert.ok(!log.includes(PNG_B64) && !log.includes('s3cret-typed'), log);
  });
});
