import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The configure and post-upgrade hooks write ~/zylos/components/openmax/config.json, which holds
// credentials (cf_access.client_secret, agent.api_key). Each case runs the real hook as a child
// process with HOME and ZYLOS_DIR in a temporary directory and a minimal environment.
// DEPLOY_REGION=cn makes post-upgrade skip its companion-component install, and the config has no
// api_key, so neither hook runs zylos or makes a network request. Run for changes to how these
// hooks write config.json.

const HOOKS = path.dirname(fileURLToPath(import.meta.url));
const RECORD_RENAMES = path.join(HOOKS, '../test/helpers/record-renames.mjs');
const TIMEOUT_MS = 30_000;

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-hook-'));
  fs.mkdirSync(path.join(home, 'zylos/components/openmax'), { recursive: true });
  return home;
}

const configPath = (home) => path.join(home, 'zylos/components/openmax/config.json');
const modeOf = (file) => fs.statSync(file).mode & 0o777;

// Runs a hook under umask 022, where a file created without an explicit mode is 0644 (the child
// inherits the umask). Returns the spawnSync result.
function runHook(script, home, { input = '', nodeArgs = [], env = {} } = {}) {
  const previous = process.umask(0o022);
  try {
    return spawnSync(process.execPath, [...nodeArgs, path.join(HOOKS, script)], {
      input,
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      killSignal: 'SIGKILL',
      env: {
        HOME: home,
        ZYLOS_DIR: path.join(home, 'zylos'),
        PATH: path.dirname(process.execPath),
        DEPLOY_REGION: 'cn',
        ...env,
      },
    });
  } finally {
    process.umask(previous);
  }
}

function assertExitedZero(result) {
  assert.equal(result.error, undefined, `hook did not run to completion: ${result.error?.message}`);
  assert.equal(result.status, 0, `hook exited ${result.status}: ${String(result.stderr).slice(0, 2000)}`);
}

test('configure leaves an existing 0644 config.json owner-only, with the endpoint written', () => {
  const home = tempHome();
  try {
    const cfg = configPath(home);
    fs.writeFileSync(cfg, JSON.stringify({ server: { bff_url: 'https://old.example' } }));
    fs.chmodSync(cfg, 0o644);
    const result = runHook('configure.js', home, { input: JSON.stringify({ COCO_BFF_URL: 'https://new.example' }) });
    assertExitedZero(result);
    assert.equal(modeOf(cfg).toString(8), '600');
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).server.bff_url, 'https://new.example');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the first config.json configure creates is owner-only', () => {
  const home = tempHome();
  try {
    const result = runHook('configure.js', home, { input: JSON.stringify({ COCO_BFF_URL: 'https://new.example' }) });
    assertExitedZero(result);
    assert.equal(modeOf(configPath(home)).toString(8), '600');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('post-upgrade replaces a 0644 config.json it migrates with a file that is owner-only at the rename', () => {
  const home = tempHome();
  try {
    const cfg = configPath(home);
    // workspace_id is a legacy key, so post-upgrade migrates and rewrites the file.
    fs.writeFileSync(cfg, JSON.stringify({ server: { bff_url: '' }, workspace_id: 'legacy', orgs: {} }));
    fs.chmodSync(cfg, 0o644);
    const log = path.join(home, 'renames.log');
    const result = runHook('post-upgrade.js', home, {
      nodeArgs: ['--import', RECORD_RENAMES],
      env: { RECORD_RENAME_TARGET: cfg, RECORD_RENAME_LOG: log },
    });
    assertExitedZero(result);
    // The hook also tightens config.json at its end, so the final mode alone cannot show the window
    // between the rename and that later step; the mode at the rename does.
    assert.equal(fs.readFileSync(log, 'utf8'), '600\n', 'one rename onto config.json, from an owner-only file');
    assert.equal(modeOf(cfg).toString(8), '600');
    assert.equal(JSON.parse(fs.readFileSync(cfg, 'utf8')).workspace_id, undefined, 'the migration was written');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
