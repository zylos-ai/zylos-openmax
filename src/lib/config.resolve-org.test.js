import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Coverage for resolveDefaultOrgId()'s COCO_ORG_ID validation + logging
// (owner 2026-08-18). CONFIG_PATH is derived from HOME at module load, so each
// case runs in a subprocess with an isolated HOME whose config.orgs is fixed.
// The driver prints `RESULT:<orgId>` to stdout (so a stray log would corrupt
// it) and lets [config] logs flow to stderr, which we assert separately.

const configUrl = pathToFileURL(fileURLToPath(new URL('./config.js', import.meta.url))).href;

// enabled: pass `false` to disable an org (enabled:false), else it's enabled.
function setupHome(orgs) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-resolveorg-'));
  const compDir = path.join(home, 'zylos/components/openmax');
  fs.mkdirSync(compDir, { recursive: true });
  const orgBlocks = {};
  for (const o of orgs) {
    orgBlocks[o.org_id] = { org_id: o.org_id, enabled: o.enabled !== false };
  }
  fs.writeFileSync(
    path.join(compDir, 'config.json'),
    JSON.stringify({ agent: { api_key: 'cwsk_test' }, orgs: orgBlocks }),
  );
  return home;
}

// Run the resolver once under a given HOME/COCO_ORG_ID; capture result + stderr.
function resolve(home, env = {}) {
  const driver =
    `import('${configUrl}').then((m) => {`
    + `process.stdout.write('RESULT:' + m.resolveDefaultOrgId()); });`;
  const r = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', driver],
    {
      env: { ...process.env, HOME: home, COCO_ORG_LOG: '', COCO_ORG_ID: '', ...env },
      encoding: 'utf-8',
    },
  );
  assert.equal(r.status, 0, `driver exited non-zero: ${r.stderr}`);
  return { result: (r.stdout || '').replace(/^RESULT:/, ''), stderr: r.stderr || '' };
}

const A = '019f0000-0000-0000-0000-00000000000a';
const B = '019f0000-0000-0000-0000-00000000000b';

test('single enabled + COCO_ORG_ID matches → returns it, no WARN', () => {
  const { result, stderr } = resolve(setupHome([{ org_id: A }]), { COCO_ORG_ID: A });
  assert.equal(result, A);
  assert.doesNotMatch(stderr, /not an enabled org/, 'valid path must not WARN');
});

test('single enabled + COCO_ORG_ID bad value → falls back to sole org, WARN', () => {
  const { result, stderr } = resolve(setupHome([{ org_id: A }]), { COCO_ORG_ID: 'bogus-org' });
  assert.equal(result, A);
  assert.match(
    stderr,
    /COCO_ORG_ID=bogus-org is not an enabled org \(1 enabled \/ 1 configured\); falling back to sole enabled org 019f0000-0000-0000-0000-00000000000a/,
  );
});

test('TRULY-EMPTY config.orgs map + COCO_ORG_ID set → trusts env (env-only deployment passthrough), no WARN', () => {
  // 0 CONFIGURED orgs → nothing to validate against → the env value is NOT a
  // bad value; it is a supported env-only deployment. (Contrast the
  // populated-but-all-disabled case below, which fails closed.)
  const { result, stderr } = resolve(setupHome([]), { COCO_ORG_ID: 'org-env-only' });
  assert.equal(result, 'org-env-only');
  assert.doesNotMatch(stderr, /not an enabled org/, 'env-only passthrough must not WARN');
});

test('P1: POPULATED-but-all-disabled config.orgs + COCO_ORG_ID (even the disabled org) → FAIL CLOSED, returns "" (→400)', () => {
  // configuredCount > 0 with 0 enabled is a deliberately-disabled tenant, NOT
  // an env-only deployment. The env value must NOT be trusted — even when it
  // points at the disabled org itself.
  const { result, stderr } = resolve(
    setupHome([{ org_id: A, enabled: false }, { org_id: B, enabled: false }]),
    { COCO_ORG_ID: A },
  );
  assert.equal(result, '', 'must NOT trust env for a populated-but-all-disabled config');
  assert.match(stderr, /COCO_ORG_ID=019f0000-0000-0000-0000-00000000000a is not an enabled org \(0 enabled \/ 2 configured\); refusing to guess \(-> 400\)/);
});

test('multi enabled + COCO_ORG_ID matches one → returns that one, no WARN', () => {
  const { result, stderr } = resolve(setupHome([{ org_id: A }, { org_id: B }]), { COCO_ORG_ID: B });
  assert.equal(result, B);
  assert.doesNotMatch(stderr, /not an enabled org/);
});

test('multi enabled + COCO_ORG_ID bad value → returns "" (→400), WARN refusing to guess', () => {
  const { result, stderr } = resolve(setupHome([{ org_id: A }, { org_id: B }]), { COCO_ORG_ID: 'bogus-org' });
  assert.equal(result, '');
  assert.match(
    stderr,
    /COCO_ORG_ID=bogus-org is not an enabled org \(2 enabled \/ 2 configured\); refusing to guess \(-> 400\)/,
  );
});

test('env names a DISABLED org (with another enabled) → bad value, falls back to sole enabled org', () => {
  const { result, stderr } = resolve(
    setupHome([{ org_id: A, enabled: false }, { org_id: B }]),
    { COCO_ORG_ID: A },
  );
  assert.equal(result, B, 'disabled env org is a bad value; sole enabled org B is used');
  assert.match(stderr, /is not an enabled org \(1 enabled \/ 2 configured\); falling back to sole enabled org 019f0000-0000-0000-0000-00000000000b/);
});

test('no COCO_ORG_ID + single enabled → returns sole org', () => {
  const { result } = resolve(setupHome([{ org_id: A }]));
  assert.equal(result, A);
});

test('no COCO_ORG_ID + multi enabled → returns "" (caller 400s)', () => {
  const { result } = resolve(setupHome([{ org_id: A }, { org_id: B }]));
  assert.equal(result, '');
});
