import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChannelInstaller } from './channel-connector.js';

// Connecting a channel writes its credentials into ~/zylos/.env through the installer's own
// .env writer (no writeEnv override). HOME is a temporary directory; zylos/pm2 calls, the
// credential pull and the result report are stubbed, so nothing outside that directory is
// touched. Run for changes to how channel credentials are written to .env.

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

// Under umask 022 a file created without an explicit mode is 0644, which is what the writer used to produce.
function withUmask022(fn) {
  const previous = process.umask(0o022);
  return Promise.resolve().then(fn).finally(() => process.umask(previous));
}

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'om-env-'));
  fs.mkdirSync(path.join(home, 'zylos'), { recursive: true });
  return home;
}

const modeOf = (file) => fs.statSync(file).mode & 0o777;

test('connecting a channel leaves an existing 0644 .env owner-only, with the old lines kept', async () => {
  const home = tempHome();
  try {
    const envPath = path.join(home, 'zylos/.env');
    fs.writeFileSync(envPath, 'TZ=Asia/Shanghai\nFEISHU_APP_ID=old\n', { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);
    const { handle, reports } = installer(home);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.equal(reports.at(-1)?.status, 'connected');
    assert.equal(modeOf(envPath).toString(8), '600');
    assert.equal(fs.readFileSync(envPath, 'utf8'), 'TZ=Asia/Shanghai\nFEISHU_APP_ID=aid\nFEISHU_APP_SECRET=asec\n');
    assert.deepEqual(fs.readdirSync(path.join(home, 'zylos')).filter((n) => n.includes('.tmp.')), [], 'no temporary file is left');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the first .env a channel connect creates is owner-only', async () => {
  const home = tempHome();
  try {
    const envPath = path.join(home, 'zylos/.env');
    const { handle } = installer(home);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.equal(modeOf(envPath).toString(8), '600');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the temporary file holding the credentials is owner-only before it replaces .env', async () => {
  const home = tempHome();
  try {
    const envPath = path.join(home, 'zylos/.env');
    fs.writeFileSync(envPath, 'TZ=UTC\n');
    fs.chmodSync(envPath, 0o644);
    // Real fs, observing each rename onto .env: the mode the temporary file has at that moment.
    const tempModes = [];
    const fsDep = {
      ...fs,
      renameSync(from, to) {
        if (to === envPath) tempModes.push(modeOf(from).toString(8));
        return fs.renameSync(from, to);
      },
    };
    const { handle } = installer(home, fsDep);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.deepEqual(tempModes, ['600'], 'one rename onto .env, from an owner-only file');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a leftover 0644 temporary file from an interrupted write does not make .env readable to others', async () => {
  const home = tempHome();
  try {
    const envPath = path.join(home, 'zylos/.env');
    fs.writeFileSync(envPath, 'TZ=UTC\n', { mode: 0o600 });
    // An earlier write by a process with the same pid stopped before its rename. Opening an existing
    // file does not apply a creation mode, so this file keeps 0644 when it is written again.
    const leftover = `${envPath}.tmp.${process.pid}`;
    fs.writeFileSync(leftover, 'stale\n');
    fs.chmodSync(leftover, 0o644);
    const { handle } = installer(home);
    await withUmask022(() => handle(ORG, connectFeishu));
    assert.equal(modeOf(envPath).toString(8), '600');
    assert.equal(fs.existsSync(leftover), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
