/**
 * Tests for the upgrade executor's pure/injectable logic: the start guard,
 * the fatal-crash marker builder, and verification poll boundaries.
 *
 * The executor script is CJS and only runs its main() when executed directly
 * (require.main === module), so importing it here is side-effect free. HOME is
 * pointed at a temp dir during import so every path the module derives
 * (marker, logs) lands in the sandbox.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-executor-test-'));
fs.mkdirSync(path.join(tmpDir, 'zylos/components/openmax/runtime'), { recursive: true });

const originalHome = process.env.HOME;
process.env.HOME = tmpDir;
const executor = (await import('../../scripts/upgrade-executor.cjs')).default;
process.env.HOME = originalHome;

const {
  evaluateStartGuard,
  buildFatalMarkerUpdate,
  verifyUpgrade,
  STALE_RUNNING_THRESHOLD_MS,
} = executor;

const NOW = 500 * 60 * 1000; // arbitrary fixed clock
const MY_PID = 4242;

describe('upgrade-executor start guard (interrupted-run detection)', () => {
  it('missing marker → exit-stale', () => {
    assert.equal(evaluateStartGuard(null, NOW, MY_PID).action, 'exit-stale');
  });

  it('terminal marker → exit-stale (cheap no-op on autorestart relaunch, F12)', () => {
    assert.equal(evaluateStartGuard({ status: 'completed', ts: NOW }, NOW, MY_PID).action, 'exit-stale');
    assert.equal(evaluateStartGuard({ status: 'failed', ts: NOW }, NOW, MY_PID).action, 'exit-stale');
  });

  it('running marker past the stale threshold → exit-stale (never acts on old state)', () => {
    const marker = { status: 'running', ts: NOW - (STALE_RUNNING_THRESHOLD_MS + 1) };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'exit-stale');
  });

  it('fresh unclaimed running marker → proceed (the real run)', () => {
    const marker = { status: 'running', ts: NOW - 5000 };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'proceed');
  });

  it('fresh running marker claimed by our own pid → proceed (idempotent re-read)', () => {
    const marker = { status: 'running', ts: NOW - 5000, executorPid: MY_PID };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'proceed');
  });

  it('fresh running marker claimed by a DIFFERENT pid → interrupted, never re-run (F2/F12)', () => {
    const marker = { status: 'running', ts: NOW - 5000, executorPid: MY_PID + 1 };
    const res = evaluateStartGuard(marker, NOW, MY_PID);
    assert.equal(res.action, 'interrupted');
    assert.ok(res.reason.includes(String(MY_PID + 1)));
  });

  it('claimed marker that has gone stale → exit-stale wins over interrupted', () => {
    const marker = {
      status: 'running',
      ts: NOW - (STALE_RUNNING_THRESHOLD_MS + 1),
      executorPid: MY_PID + 1,
    };
    assert.equal(evaluateStartGuard(marker, NOW, MY_PID).action, 'exit-stale');
  });
});

describe('buildFatalMarkerUpdate (top-level main().catch marker write)', () => {
  it('running marker → terminal failed update carrying the error message', () => {
    const upd = buildFatalMarkerUpdate(new Error('kaboom'), { status: 'running', from: '1.0.0', to: '1.1.0' });
    assert.equal(upd.status, 'failed');
    assert.equal(upd.completed, false);
    assert.ok(upd.error.includes('kaboom'));
    assert.ok(upd.detail.length > 0);
  });

  it('marker already terminal → null (never overwrite a real outcome)', () => {
    assert.equal(buildFatalMarkerUpdate(new Error('x'), { status: 'completed', completed: true }), null);
    assert.equal(buildFatalMarkerUpdate(new Error('x'), { status: 'failed', error: 'earlier' }), null);
  });

  it('no marker at all → null (nothing to update)', () => {
    assert.equal(buildFatalMarkerUpdate(new Error('x'), null), null);
  });

  it('non-Error throw values are stringified', () => {
    const upd = buildFatalMarkerUpdate('string-throw', { status: 'running' });
    assert.ok(upd.error.includes('string-throw'));
  });
});

describe('verifyUpgrade poll boundaries (injected deps, no real sleeps/pm2)', () => {
  // Scripted poll sequence: each entry is one poll's observed world state.
  // readInstalledVersion is called before getPm2Proc in each poll; the index
  // advances in getPm2Proc.
  function scripted(polls) {
    let i = 0;
    const at = () => polls[Math.min(i, polls.length - 1)];
    return {
      sleep: async () => {},
      readInstalledVersion: () => at().version,
      getPm2Proc: () => {
        const p = at();
        i += 1;
        if (!p.status) return null;
        return { pm2_env: { status: p.status, restart_time: p.restarts ?? 0 } };
      },
    };
  }

  const down = { version: '1.0.0', status: null };
  const healthy = (restarts = 0) => ({ version: '2.0.0', status: 'online', restarts });

  it('first healthy sighting on the FINAL poll gets one extra confirmation poll and passes', async () => {
    const deps = scripted([down, down, healthy(1), healthy(1)]);
    const ok = await verifyUpgrade('2.0.0', 3, deps);
    assert.equal(ok, true, 'healthy-at-deadline service must not be declared failed');
  });

  it('the extra confirmation poll is granted at most once', async () => {
    // Healthy at the final slot, then down again on the single extra poll.
    const deps = scripted([down, down, healthy(1), down, healthy(1), healthy(1)]);
    const ok = await verifyUpgrade('2.0.0', 3, deps);
    assert.equal(ok, false, 'only one extension is allowed');
  });

  it('two consecutive healthy polls with steady restart counter → success', async () => {
    const ok = await verifyUpgrade('2.0.0', 6, scripted([healthy(3), healthy(3)]));
    assert.equal(ok, true);
  });

  it('climbing restart counter between polls → crash-loop failure', async () => {
    const ok = await verifyUpgrade('2.0.0', 6, scripted([healthy(3), healthy(4)]));
    assert.equal(ok, false);
  });

  it('never healthy → failure after the scheduled polls', async () => {
    const ok = await verifyUpgrade('2.0.0', 2, scripted([down, down]));
    assert.equal(ok, false);
  });
});
