import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression (auto-task #13, reviewer zylos0t NEEDS-FIX).
//
// The repo-wide org-scoping refactor routed every comm.* verb through
// resolveOrgConfig(), which read command args + config.orgs ONLY and no longer
// consulted COCO_ORG_ID. A deployment that selects its operating org PURELY via
// COCO_ORG_ID (org NOT present in config.orgs) then 400'd BEFORE sending —
// breaking the PR/CHANGELOG promise that "single-org / COCO_ORG_ID deployments
// [are] unchanged".
//
// These tests pin the no-{org} env-fallback behavior end-to-end via subprocess
// (the CLI runs main() on import), with an isolated HOME whose config.orgs is
// empty so the org is determined SOLELY by COCO_ORG_ID.

const commCli = fileURLToPath(new URL('./comm.js', import.meta.url));

// Empty HOME: config.orgs is empty, so no org comes from config — only the
// env var can select one. api_key present so the real token exchange can run.
function setupEmptyHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-envorg-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/tokens'), { recursive: true });
  fs.writeFileSync(
    path.join(compDir, 'config.json'),
    JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: {} }),
  );
  return home;
}

function run(home, command, params, env, apiUrl) {
  return new Promise((resolve) => {
    execFile(process.execPath, [commCli, command, JSON.stringify(params)], {
      env: {
        ...process.env,
        HOME: home,
        COCO_API_URL: apiUrl,
        COCO_API_PREFIX: '/api/v1',
        COCO_RPC_LOG: '0',
        ...env,
      },
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

// Mints tok-<org_id> at /auth/agent/token so the bearer the CLI presents proves
// which org's JWT was routed; records the first hit on `pathMatch`.
function orgTokenHarness(pathMatch) {
  const seen = { hit: false, auth: null, method: null, url: null };
  const server = createServer((req, res) => {
    if (req.url.includes('/auth/agent/token')) {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let orgId = '';
        try { orgId = JSON.parse(body || '{}').org_id || ''; } catch { /* identity */ }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          access_token: `tok-${orgId || 'identity'}`,
          access_token_expires_at: 9999999999000,
          refresh_token: `r-${orgId || 'identity'}`,
          refresh_token_expires_at: 9999999999000,
        }));
      });
      return;
    }
    if (req.url.startsWith(pathMatch)) {
      seen.hit = true;
      seen.auth = req.headers.authorization || null;
      seen.method = req.method;
      seen.url = req.url;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [], request_id: 'r1' }));
  });
  return { server, seen };
}

test('env-only regression: comm.list_conversations with COCO_ORG_ID (org NOT in config.orgs) SENDS, carrying that org\'s exchanged JWT', async () => {
  const home = setupEmptyHome();
  const { server, seen } = orgTokenHarness('/api/v1/conversations');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // No COCO_AUTH_TOKEN / COCO_USER_TOKEN so the real per-org token exchange runs.
    const r = await run(home, 'comm.list_conversations', {}, {
      COCO_ORG_ID: 'org-env-only',
      COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '', COCO_API_KEY: '',
    }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 0, `expected success (request sent), got stderr: ${r.stderr}`);
    assert.equal(seen.hit, true, 'the GET /conversations must be sent (was suppressed by the pre-fix 400)');
    assert.equal(seen.method, 'GET');
    assert.equal(
      seen.auth, 'Bearer tok-org-env-only',
      'must carry the COCO_ORG_ID org\'s exchanged JWT, not an identity-only token',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('negative control: same empty config.orgs but COCO_ORG_ID unset → fail-fast 400, NOTHING sent (the multi/zero-org guard still holds)', async () => {
  const home = setupEmptyHome();
  const { server, seen } = orgTokenHarness('/api/v1/conversations');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await run(home, 'comm.list_conversations', {}, {
      COCO_ORG_ID: '', COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '',
    }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 1, `expected fail-fast, got stdout: ${r.stdout}`);
    const err = JSON.parse(r.stderr);
    assert.equal(err.status, 400, `expected 400, got: ${r.stderr}`);
    assert.match(err.error, /no enabled orgs in config\.orgs/);
    assert.equal(seen.hit, false, 'must NOT send any conversations request when no org is determined');
  } finally {
    await new Promise((r) => server.close(r));
  }
});
