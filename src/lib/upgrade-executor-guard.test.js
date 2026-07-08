/**
 * Tests for the upgrade executor's pure start-guard decision logic.
 *
 * The executor script is CJS and only runs its main() when executed directly
 * (require.main === module), so importing it here is side-effect free.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import executor from '../../scripts/upgrade-executor.cjs';

const { evaluateStartGuard, STALE_RUNNING_THRESHOLD_MS } = executor;

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
