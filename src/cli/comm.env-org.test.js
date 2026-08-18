import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Env-org resolution semantics for comm.resolveOrgConfig()'s no-{org} branch.
//
// History: auto-task #13 first made a COCO_ORG_ID that was NOT in config.orgs
// route as a minimal { org_id } env-only block (so such deployments could
// send). Owner 2026-08-18 REVERSED that: the two resolution paths
// (comm.resolveOrgConfig + config.resolveDefaultOrgId) are now CONSISTENT and
// treat a COCO_ORG_ID that is not an ENABLED config org as a BAD VALUE:
//   - matches an enabled config org → use it;
//   - bad value + exactly one enabled org → fall back to it (WARN);
//   - bad value + zero or multiple enabled orgs → fail-fast 400, nothing sent.
// These tests pin that behavior end-to-end via subprocess (the CLI runs main()
// on import), with an isolated HOME whose config.orgs we control.

const commCli = fileURLToPath(new URL('./comm.js', import.meta.url));

// Empty HOME: config.orgs is empty, so NO org is enabled. Under the new
// semantics a COCO_ORG_ID here is a bad value with no sole org to fall back to.
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

// HOME with N enabled config orgs (keyed by org_id, each with a slug/self so
// they are real config blocks). Used to exercise the enabled-match and
// single-org bad-value fallback branches.
function setupHomeWithOrgs(orgIds) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'comm-envorg-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(path.join(compDir, 'runtime/tokens'), { recursive: true });
  const orgs = {};
  for (const id of orgIds) {
    orgs[id] = { org_id: id, enabled: true, self: { member_id: `self-${id}` } };
  }
  fs.writeFileSync(
    path.join(compDir, 'config.json'),
    JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs }),
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

test('env-only deployment: COCO_ORG_ID with EMPTY config.orgs SENDS, carrying that org\'s exchanged JWT (nothing to validate against → trust env)', async () => {
  // With ZERO enabled config orgs there is no populated config set to call the
  // env value "bad" relative to, so resolveOrgConfig carries a minimal
  // { org_id } routing block and the request goes out — the pre-existing
  // supported env-only path (Bug B / review #13). The bad-value semantics only
  // kick in when a non-empty enabled config set exists (see the tests below).
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
    assert.equal(seen.hit, true, 'the GET /conversations must be sent for an env-only deployment');
    assert.equal(seen.method, 'GET');
    assert.equal(
      seen.auth, 'Bearer tok-org-env-only',
      'must carry the COCO_ORG_ID org\'s exchanged JWT, not an identity-only token',
    );
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('NEW semantics: COCO_ORG_ID matches an ENABLED config org → SENDS, carrying that org\'s exchanged JWT', async () => {
  const home = setupHomeWithOrgs(['org-A', 'org-B']);
  const { server, seen } = orgTokenHarness('/api/v1/conversations');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await run(home, 'comm.list_conversations', {}, {
      COCO_ORG_ID: 'org-B',
      COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '', COCO_API_KEY: '',
    }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 0, `expected success (request sent), got stderr: ${r.stderr}`);
    assert.equal(seen.hit, true, 'the GET /conversations must be sent for an enabled env org');
    assert.equal(seen.auth, 'Bearer tok-org-B', 'must carry the enabled COCO_ORG_ID org\'s JWT');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('NEW semantics: bad-value COCO_ORG_ID + exactly ONE enabled org → falls back to the sole enabled org, SENDS carrying ITS JWT (single-org deployments stay resilient)', async () => {
  const home = setupHomeWithOrgs(['org-A']);
  const { server, seen } = orgTokenHarness('/api/v1/conversations');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await run(home, 'comm.list_conversations', {}, {
      COCO_ORG_ID: 'bogus-org',
      COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '', COCO_API_KEY: '',
    }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 0, `expected success (fallback send), got stderr: ${r.stderr}`);
    assert.equal(seen.hit, true, 'must send using the sole enabled org');
    assert.equal(seen.auth, 'Bearer tok-org-A', 'must carry the sole enabled org\'s JWT, not the bogus env value');
    assert.match(r.stderr, /not an enabled org; falling back to sole enabled org org-A/, 'expected a WARN on stderr');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('NEW semantics: bad-value COCO_ORG_ID + MULTIPLE enabled orgs → fail-fast 400 (refuse to guess), NOTHING sent', async () => {
  const home = setupHomeWithOrgs(['org-A', 'org-B']);
  const { server, seen } = orgTokenHarness('/api/v1/conversations');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await run(home, 'comm.list_conversations', {}, {
      COCO_ORG_ID: 'bogus-org',
      COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '', COCO_API_KEY: '',
    }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 1, `expected fail-fast, got stdout: ${r.stdout}`);
    const err = JSON.parse(r.stderr);
    assert.equal(err.status, 400, `expected 400, got: ${r.stderr}`);
    assert.match(err.error, /COCO_ORG_ID=bogus-org is not an enabled org and multiple orgs are enabled/);
    assert.equal(seen.hit, false, 'must NOT send when it cannot safely pick an org');
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

// -----------------------------------------------------------------------------
// Sibling blocker (auto-task #13, reviewer zylos0t re-review NEEDS-FIX).
//
// resolveOrgConfig() carries a MINIMAL { org_id } routing block for a
// COCO_ORG_ID that is not in config.orgs (the env-only deployment path pinned
// above). That is correct for the HTTP/JWT-routed verbs (list_conversations),
// but it MUST NOT flow into the CONFIG-BACKED comm commands (sync_owner,
// dm_policy read+write, dm_list, dm_allow, dm_revoke), which need a real
// slug/self/access block. resolveConfiguredOrg() rejects the slug-less block
// with an actionable 400 instead of fabricating success or crashing.
//
// These pin the intended fail-fast: with empty config.orgs + COCO_ORG_ID set,
// each of the 6 config-backed commands returns an ACTIONABLE 400 (no crash, no
// fake success, no config mutation, no config-read API call).

const ACTIONABLE = /selected via COCO_ORG_ID has no block in config\.orgs/;

// Read config.orgs back off disk to prove no fake write happened.
function readOrgs(home) {
  const cfgPath = path.join(home, 'zylos/components/openmax/config.json');
  return JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).orgs;
}

// Assert an env-only config-backed command fails fast with an actionable 400
// and touched neither the mock API nor config.json.
async function expectConfigMiss400(command, params) {
  const home = setupEmptyHome();
  // Match any REST path so ANY leaked call (config-read or member fetch) trips it.
  const { server, seen } = orgTokenHarness('/api/v1/');
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const r = await run(home, command, params, {
      COCO_ORG_ID: 'org-env-only',
      COCO_AUTH_TOKEN: '', COCO_USER_TOKEN: '', COCO_API_KEY: '',
    }, `http://127.0.0.1:${port}`);
    assert.equal(r.code, 1, `${command}: expected fail-fast (not fake success), got stdout: ${r.stdout}`);
    // stderr must be a clean error envelope — proves no crash/stack trace.
    let err;
    assert.doesNotThrow(() => { err = JSON.parse(r.stderr); }, `${command}: stderr not a clean error envelope (crash?): ${r.stderr}`);
    assert.equal(err.status, 400, `${command}: expected 400, got: ${r.stderr}`);
    assert.match(err.error, ACTIONABLE, `${command}: error must be the actionable config-miss message, got: ${err.error}`);
    assert.equal(seen.hit, false, `${command}: must NOT hit the API for a non-existent env-only org`);
    // No fake config mutation — orgs stays empty.
    assert.deepEqual(readOrgs(home), {}, `${command}: must NOT mutate config.orgs`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('config-miss regression: comm.dm_list (env-only org NOT in config.orgs) → actionable 400, no fake success', async () => {
  await expectConfigMiss400('comm.dm_list', {});
});

test('config-miss regression: comm.dm_policy READ (env-only org NOT in config.orgs) → actionable 400, no fake {dmPolicy} success', async () => {
  await expectConfigMiss400('comm.dm_policy', {});
});

test('config-miss regression: comm.dm_policy WRITE (env-only org NOT in config.orgs) → actionable 400, no crash, no config write', async () => {
  await expectConfigMiss400('comm.dm_policy', { policy: 'open' });
});

test('config-miss regression: comm.dm_allow (env-only org NOT in config.orgs) → actionable 400, no crash, no config write', async () => {
  await expectConfigMiss400('comm.dm_allow', { memberId: 'm-1' });
});

test('config-miss regression: comm.dm_revoke (env-only org NOT in config.orgs) → actionable 400, no crash, no config write', async () => {
  await expectConfigMiss400('comm.dm_revoke', { memberId: 'm-1' });
});

test('config-miss regression: comm.sync_owner (env-only org NOT in config.orgs) → actionable 400, no member fetch, no org "undefined"', async () => {
  await expectConfigMiss400('comm.sync_owner', {});
});
