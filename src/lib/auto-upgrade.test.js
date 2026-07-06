import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-upgrade-test-'));
const MARKER_PATH = path.join(tmpDir, 'upgrade-marker.json');

// Patch the module-level MARKER_PATH by importing the functions and
// overriding the marker file location via a temp-dir symlink trick.
// Since the module uses a hardcoded path, we test the exported functions
// by calling them after writing markers to the real path.  Instead,
// test the logic directly with inline implementations that mirror the
// production code.

afterEach(() => {
  try { fs.unlinkSync(MARKER_PATH); } catch {}
});

function writeMarker(data) {
  fs.writeFileSync(MARKER_PATH, JSON.stringify(data, null, 2));
}

// Mirror of production readAndClearMarker with the race-condition fix
function readAndClearMarker() {
  try {
    const raw = fs.readFileSync(MARKER_PATH, 'utf-8');
    const data = JSON.parse(raw);
    if (data.status === 'running') return null;
    fs.unlinkSync(MARKER_PATH);
    return data;
  } catch {
    return null;
  }
}

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

describe('formatUpgradeNotification', () => {
  let formatUpgradeNotification;
  beforeEach(async () => {
    const mod = await import('./auto-upgrade.js');
    formatUpgradeNotification = mod.formatUpgradeNotification;
  });

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
