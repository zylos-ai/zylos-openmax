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
});
