import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Org-scoping of the cws-connect verbs (connector-403 fix).
//
// Every cws-connect route is org-scoped: cws-core requires an org-scoped JWT and
// 403s ("org membership required") on an identity-only token. On a MULTI-org
// agent with no {org} and no COCO_ORG_ID, the default-org resolver returns '' —
// a bare get()/post() would then go out identity-only and hit that 403. Each
// verb must instead resolve the org via requireOrgId(), which FAILS FAST with an
// actionable 400 BEFORE any network call; and when {org} IS given it must pass
// through to the org-scoped endpoint. conn.js guards main() behind an is-main
// check, so these are exercised via subprocess (execFile).
//
// (This lives in its own file rather than conn.test.js so it does not collide
// with the multi-connection-disambiguation PR, which adds conn.test.js
// independently; both files coexist and both run under `node --test`.)

const cliPath = fileURLToPath(new URL('./conn.js', import.meta.url));

function setupMultiOrgHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'conn-multiorg-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  const connDir = path.join(compDir, 'runtime/connect');
  fs.mkdirSync(connDir, { recursive: true });
  fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify({
    orgs: {
      'org-1': { enabled: true, org_id: 'org-1', self: { member_id: 'm-1' } },
      'org-2': { enabled: true, org_id: 'org-2', self: { member_id: 'm-2' } },
    },
  }));
  return home;
}

// Forces COCO_ORG_ID='' so the multi-org "no default org" path is exercised
// deterministically regardless of the test runner's own environment.
// COCO_AUTH_TOKEN short-circuits the JWT exchange; the default COCO_API_URL
// points at an unroutable port so any stray network call would fail fast with a
// DIFFERENT error the assertions would catch.
function runConnMultiOrg(home, command, params, apiUrl = 'http://127.0.0.1:1') {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_AUTH_TOKEN: 'test-token',
        COCO_ORG_ID: '',               // no default org → resolveDefaultOrgId() === ''
        COCO_RPC_LOG: '0',
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

for (const c of [
  { command: 'conn.list', params: {} },
  { command: 'conn.status', params: { connectionId: 'c1' } },
  { command: 'conn.acquire', params: { connectionId: 'c1' } },
  { command: 'conn.actions', params: { connectionId: 'c1' } },
  { command: 'conn.execute', params: { connectionId: 'c1', action: 'toolkit/act' } },
  { command: 'conn.app_actions', params: { applicationId: 'app-1' } },
  { command: 'conn.proxy', params: { connectionId: 'c1', url: 'https://example.test' } },
]) {
  test(`org-scoping fail-fast: ${c.command} 多 org 且未给 {org} → 400（不静默走 identity-only）`, async () => {
    const home = setupMultiOrgHome();
    const { code, stderr } = await runConnMultiOrg(home, c.command, c.params);
    assert.equal(code, 1);
    const err = JSON.parse(stderr);
    assert.equal(err.status, 400);
    assert.match(err.error, /cannot resolve org|multiple orgs/i);
  });
}

test('org-scoping: 给 {org} → 直通到 org-scoped 端点（conn.status 命中本地 server）', async () => {
  const home = setupMultiOrgHome();
  const server = createServer((req, res) => {
    if (req.url.includes('/connect/connections/c1')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { id: 'c1', status: 'active' }, request_id: 'r1' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"error":{"detail":"unexpected"},"request_id":"r0"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const { code, stdout } = await runConnMultiOrg(home, 'conn.status', { connectionId: 'c1', org: 'org-2' }, `http://127.0.0.1:${port}`);
    assert.equal(code, 0);
    const out = JSON.parse(stdout);
    assert.equal(out.id, 'c1');
    assert.equal(out.status, 'active');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
