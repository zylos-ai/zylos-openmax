import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-upgrade-test-'));
const runtimeDir = path.join(tmpDir, 'zylos/components/openmax/runtime');
fs.mkdirSync(runtimeDir, { recursive: true });
const MARKER_PATH = path.join(runtimeDir, 'upgrade-marker.json');
const FAILED_VERSION_PATH = path.join(runtimeDir, 'upgrade-failed-version');

const originalHome = process.env.HOME;
process.env.HOME = tmpDir;
const mod = await import(`./auto-upgrade.js?test=${process.pid}`);
process.env.HOME = originalHome;

const {
  readAndClearMarker,
  formatUpgradeNotification,
  getFailedVersion,
  clearFailedVersion,
  recordFailedVersion,
  classifyUpgraderState,
  startUpgraderApp,
  GRACE_START_MS,
  STALE_RUNNING_THRESHOLD_MS,
} = mod;

function writeMarker(data) {
  fs.writeFileSync(MARKER_PATH, JSON.stringify(data, null, 2));
}

afterEach(() => {
  try { fs.unlinkSync(MARKER_PATH); } catch {}
  try { fs.unlinkSync(FAILED_VERSION_PATH); } catch {}
});

describe('readAndClearMarker race-condition fix', () => {
  it('skips running markers (leaves file intact for executor)', () => {
    writeMarker({ status: 'running', from: '2.4.3', to: '2.5.0', ts: Date.now() });
    const result = readAndClearMarker();
    assert.equal(result, null, 'should return null for running markers');
    assert.ok(fs.existsSync(MARKER_PATH), 'marker file should still exist');
  });

  it('consumes completed markers', () => {
    writeMarker({ status: 'completed', completed: true, from: '2.4.3', to: '2.5.0' });
    const result = readAndClearMarker();
    assert.equal(result.status, 'completed');
    assert.equal(result.completed, true);
    assert.ok(!fs.existsSync(MARKER_PATH), 'marker file should be deleted');
  });

  it('consumes failed markers', () => {
    writeMarker({ status: 'failed', completed: false, error: 'timeout', from: '2.4.3', to: '2.5.0' });
    const result = readAndClearMarker();
    assert.equal(result.status, 'failed');
    assert.equal(result.completed, false);
    assert.ok(!fs.existsSync(MARKER_PATH), 'marker file should be deleted');
  });

  it('returns null when no marker exists', () => {
    const result = readAndClearMarker();
    assert.equal(result, null);
  });
});

describe('failed version cooldown', () => {
  it('getFailedVersion returns null when no record exists', () => {
    assert.equal(getFailedVersion(), null);
  });

  it('recordFailedVersion writes and getFailedVersion reads it back', () => {
    recordFailedVersion('2.5.0');
    assert.equal(getFailedVersion(), '2.5.0');
  });

  it('clearFailedVersion removes the record', () => {
    recordFailedVersion('2.5.0');
    clearFailedVersion();
    assert.equal(getFailedVersion(), null);
  });

  it('clearFailedVersion is safe when no record exists', () => {
    assert.doesNotThrow(() => clearFailedVersion());
  });

  it('recordFailedVersion overwrites a previous record', () => {
    recordFailedVersion('2.5.0');
    recordFailedVersion('2.6.0');
    assert.equal(getFailedVersion(), '2.6.0');
  });
});

describe('formatUpgradeNotification', () => {
  it('formats success notification', () => {
    const text = formatUpgradeNotification({ completed: true, from: '2.4.3', to: '2.5.0', url: 'https://example.com' });
    assert.ok(text.includes('upgraded'));
    assert.ok(text.includes('2.4.3'));
    assert.ok(text.includes('2.5.0'));
  });

  it('formats failure notification with error', () => {
    const text = formatUpgradeNotification({ completed: false, error: 'timeout', from: '2.4.3', to: '2.5.0' });
    assert.ok(text.includes('failed'));
    assert.ok(text.includes('timeout'));
  });

  it('does not claim a rollback that did not happen', () => {
    const text = formatUpgradeNotification({ completed: false, error: 'boom', from: '2.4.3', to: '2.5.0' });
    assert.ok(!text.includes('Rolled back'), 'must not hardcode a rollback claim');
  });

  it('uses the executor-provided detail line when present', () => {
    const text = formatUpgradeNotification({
      completed: false, error: 'crash-loop', from: '2.4.3', to: '2.5.0',
      detail: 'rolled back to v2.4.3 and the service is running again.',
    });
    assert.ok(text.includes('rolled back to v2.4.3'));
  });
});

describe('classifyUpgraderState (pre-flight decision logic)', () => {
  const NOW = 100 * 60 * 1000; // arbitrary fixed clock

  it('no entry + no marker → proceed', () => {
    assert.equal(classifyUpgraderState(null, null, NOW).action, 'proceed');
  });

  it('no entry + terminal marker → proceed', () => {
    assert.equal(classifyUpgraderState(null, { status: 'completed' }, NOW).action, 'proceed');
    assert.equal(classifyUpgraderState(null, { status: 'failed' }, NOW).action, 'proceed');
  });

  it('no entry + fresh running marker (within grace) → wait (upgrader may be starting)', () => {
    const marker = { status: 'running', ts: NOW - (GRACE_START_MS - 1000) };
    assert.equal(classifyUpgraderState(null, marker, NOW).action, 'wait');
  });

  it('no entry + running marker past grace → mark-interrupted (F1: stuck marker must not linger)', () => {
    const marker = { status: 'running', ts: NOW - (GRACE_START_MS + 1000) };
    assert.equal(classifyUpgraderState(null, marker, NOW).action, 'mark-interrupted');
  });

  it('online entry + fresh running marker → wait (in flight)', () => {
    const marker = { status: 'running', ts: NOW - 60 * 1000 };
    assert.equal(classifyUpgraderState('online', marker, NOW).action, 'wait');
  });

  it('online entry + stale running marker → wait, never a delete (F5: no killing live upgraders)', () => {
    const marker = { status: 'running', ts: NOW - (STALE_RUNNING_THRESHOLD_MS + 1000) };
    const res = classifyUpgraderState('online', marker, NOW);
    assert.equal(res.action, 'wait');
    assert.ok(res.reason.includes('stale running marker'));
  });

  it('online entry + terminal marker → wait (completion window, executor self-deletes)', () => {
    assert.equal(classifyUpgraderState('online', { status: 'completed' }, NOW).action, 'wait');
  });

  it('dead entry + running marker → cleanup-and-mark-interrupted', () => {
    const marker = { status: 'running', ts: NOW - 60 * 1000 };
    assert.equal(classifyUpgraderState('stopped', marker, NOW).action, 'cleanup-and-mark-interrupted');
    assert.equal(classifyUpgraderState('errored', marker, NOW).action, 'cleanup-and-mark-interrupted');
  });

  it('dead entry + terminal/absent marker → cleanup', () => {
    assert.equal(classifyUpgraderState('errored', null, NOW).action, 'cleanup');
    assert.equal(classifyUpgraderState('stopped', { status: 'failed' }, NOW).action, 'cleanup');
  });
});

describe('startUpgraderApp', () => {
  const noUpgrader = async (args) => {
    if (args[0] === 'jlist') return { stdout: '[]' };
    return { stdout: '' };
  };

  it('success: leaves a running marker and returns true', async () => {
    const ok = await startUpgraderApp('2.5.1', '2.6.0', 'notes', 'https://x', { pm2Exec: noUpgrader });
    assert.equal(ok, true);
    const m = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
    assert.equal(m.status, 'running');
    assert.equal(m.from, '2.5.1');
    assert.equal(m.to, '2.6.0');
    assert.equal(typeof m.ts, 'number');
  });

  it('start failure: records a failed marker with ts + error instead of unlinking (F7)', async () => {
    const failingStart = async (args) => {
      if (args[0] === 'jlist') return { stdout: '[]' };
      if (args[0] === 'start') throw new Error('pm2 daemon unreachable');
      return { stdout: '' };
    };
    const before = Date.now();
    const ok = await startUpgraderApp('2.5.1', '2.6.0', '', '', { pm2Exec: failingStart });
    assert.equal(ok, false);
    const m = JSON.parse(fs.readFileSync(MARKER_PATH, 'utf-8'));
    assert.equal(m.status, 'failed');
    assert.equal(m.completed, false);
    assert.ok(m.error.includes('pm2 daemon unreachable'));
    assert.ok(m.detail.includes('never started'));
    assert.ok(m.ts >= before, 'failed marker must carry a fresh ts (F9)');
  });

  it('refuses to start while an upgrader is online (never touches it)', async () => {
    const calls = [];
    const onlineUpgrader = async (args) => {
      calls.push(args[0]);
      if (args[0] === 'jlist') {
        return { stdout: JSON.stringify([{ name: 'zylos-openmax-upgrader', pm2_env: { status: 'online' } }]) };
      }
      return { stdout: '' };
    };
    const ok = await startUpgraderApp('2.5.1', '2.6.0', '', '', { pm2Exec: onlineUpgrader });
    assert.equal(ok, false);
    assert.ok(!calls.includes('delete'), 'must not delete an online upgrader');
    assert.ok(!calls.includes('start'), 'must not start a second upgrader');
    assert.ok(!fs.existsSync(MARKER_PATH), 'must not overwrite the marker');
  });
});
