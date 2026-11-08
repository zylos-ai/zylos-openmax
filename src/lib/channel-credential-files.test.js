import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelInstaller } from './channel-connector.js';

// Connecting a channel writes its credentials into ~/zylos/.env and its settings into
// ~/zylos/components/<component>/config.json through the installer's own writers (no writeEnv /
// writeConfig override). HOME is a temporary directory; zylos/pm2 calls, the credential pull and
// the result report are stubbed, so nothing outside that directory is touched. Run for changes to
// how a channel connect writes .env or a component config.json.

const ORG = { slug: 'acme', org_id: 'org-1', self: { member_id: 'm-self' } };
const frame = (data) => ({ payload: { event: `channel.${data.action}`, data } });
const connectFeishu = frame({
  channel_type: 'feishu', action: 'connect', binding_id: 'bind-1',
  request_id: 'req-1', credential_pull_token: 'tok-1', agent_member_id: 'm-self',
});

function installer(home, fsDep) {
  const reports = [];
  const handle = createChannelInstaller({
    getForOrgWithHeaders: async () => ({ config: { app_id: 'aid', app_secret: 'asec' } }),
    apiPath: (p) => `/api/v1${p}`,
    dedupe: () => false,
    execFile: async (file, args) => {
      if (file === 'zylos' && args[0] === 'info') return { stdout: JSON.stringify({ name: args[1] }) };
      return { stdout: '' };
    },
    verifyConnected: async () => true,
    reportResult: async (r) => { reports.push(r); },
    fetchDep: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, tenant_access_token: 't' }) }),
    home,
    ...(fsDep ? { fsDep } : {}),
    qrPollMs: 0,
  });
  return { handle, reports };
}

// Real fs, recording the mode each file renamed onto `targets` has at the moment of the rename.
function renameRecorder(targets) {
  const modes = [];
  const fsDep = {
    ...fs,
    renameSync(from, to) {
      if (targets.includes(to)) modes.push(`${path.basename(to)} ${modeOf(from).toString(8)}`);
      return fs.renameSync(from, to);
    },
  };
  return { fsDep, modes };
}

// Under umask 022 a file created without an explicit mode is 0644, which is what the writers used to produce.
function withUmask022(fn) {
  const previous = process.umask(0o022);
  return Promise.resolve().then(fn).finally(() => process.umask(previous));
}

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-cred-'));
  fs.mkdirSync(path.join(home, 'zylos/components/feishu'), { recursive: true });
  return home;
}

const paths = (home) => ({
  env: path.join(home, 'zylos/.env'),
  config: path.join(home, 'zylos/components/feishu/config.json'),
});
const modeOf = (file) => fs.statSync(file).mode & 0o777;
const tempFilesIn = (dir) => fs.readdirSync(dir).filter((n) => n.includes('.tmp.'));

test('connecting a channel leaves an existing 0644 .env owner-only, with the old lines kept', async () => {
  const home = tempHome();
  try {
    const { env } = paths(home);
    fs.writeFileSync(env, 'TZ=Asia/Shanghai\nFEISHU_APP_ID=old\n');
    fs.chmodSync(env, 0o644);
    const { handle, reports } = installer(home);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.equal(reports.at(-1)?.status, 'connected');
    assert.equal(modeOf(env).toString(8), '600');
    assert.equal(fs.readFileSync(env, 'utf8'), 'TZ=Asia/Shanghai\nFEISHU_APP_ID=aid\nFEISHU_APP_SECRET=asec\n');
    assert.equal(tempFilesIn(path.join(home, 'zylos')).length, 0, 'no temporary file is left');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('connecting a channel leaves an existing 0644 component config.json owner-only, with its other keys kept', async () => {
  const home = tempHome();
  try {
    const { config } = paths(home);
    fs.writeFileSync(config, JSON.stringify({ enabled: false, bot: { name: 'kept' } }));
    fs.chmodSync(config, 0o644);
    const { handle, reports } = installer(home);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.equal(reports.at(-1)?.status, 'connected');
    assert.equal(modeOf(config).toString(8), '600');
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')),
      { enabled: true, bot: { name: 'kept' }, connection_mode: 'websocket' });
    assert.equal(tempFilesIn(path.dirname(config)).length, 0, 'no temporary file is left');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the first .env and component config.json a channel connect creates are owner-only', async () => {
  const home = tempHome();
  try {
    const { env, config } = paths(home);
    const { handle } = installer(home);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.equal(modeOf(env).toString(8), '600');
    assert.equal(modeOf(config).toString(8), '600');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the temporary files that replace .env and config.json are owner-only at the rename', async () => {
  const home = tempHome();
  try {
    const { env, config } = paths(home);
    fs.writeFileSync(env, 'TZ=UTC\n');
    fs.chmodSync(env, 0o644);
    fs.writeFileSync(config, '{}');
    fs.chmodSync(config, 0o644);
    const { fsDep, modes } = renameRecorder([env, config]);
    const { handle } = installer(home, fsDep);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.deepEqual(modes, ['.env 600', 'config.json 600'], 'one rename onto each file, each from an owner-only file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('leftover 0644 temporary files from an interrupted write are owner-only before they replace .env and config.json', async () => {
  const home = tempHome();
  try {
    const { env, config } = paths(home);
    fs.writeFileSync(env, 'TZ=UTC\n', { mode: 0o600 });
    fs.writeFileSync(config, '{}', { mode: 0o600 });
    // An earlier write by a process with the same pid stopped before its rename. Opening an existing
    // file does not apply a creation mode, so each of these keeps 0644 unless the writer sets the mode.
    const leftovers = [`${env}.tmp.${process.pid}`, `${config}.tmp.${process.pid}`];
    for (const leftover of leftovers) {
      fs.writeFileSync(leftover, 'stale\n');
      fs.chmodSync(leftover, 0o644);
    }
    const { fsDep, modes } = renameRecorder([env, config]);
    const { handle } = installer(home, fsDep);
    await withUmask022(() => handle(ORG, connectFeishu));
    // Observed at the rename, so a writer that only fixes the mode after the rename fails here.
    assert.deepEqual(modes, ['.env 600', 'config.json 600']);
    assert.equal(modeOf(env).toString(8), '600');
    assert.equal(modeOf(config).toString(8), '600');
    for (const leftover of leftovers) assert.equal(fs.existsSync(leftover), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
