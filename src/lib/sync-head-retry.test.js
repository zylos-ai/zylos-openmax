import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deliverWithInSweepRetry } from './sync-head-retry.js';

// A stub that mimics the durable per-seq give-up counter: it fails the content
// fetch every time (a PERMANENTLY unfetchable head, e.g. an empty seeded DM),
// and reports giveUp once the consecutive-failure count reaches `threshold` —
// exactly what inbox-ledger.recordContentFetchFailure + the handler do.
function permanentlyFailingHead(threshold) {
  let failures = 0;
  return async () => {
    failures += 1;
    return { contentFetchFailed: true, giveUp: failures >= threshold };
  };
}

test('stable connection, no reconnect: permanent empty head reaches giveUp within one sweep', async () => {
  // Reviewer's acceptance case (Point B): a single stable connection drives the
  // durable counter to its threshold IN-SWEEP — no reconnect needed — so the
  // caller can skip the head and deliver the backlog behind it.
  const threshold = 5;
  let backoffs = 0;
  const { result, attempts } = await deliverWithInSweepRetry(
    permanentlyFailingHead(threshold),
    { maxAttempts: 10, sleep: async () => { backoffs += 1; } },
  );
  assert.equal(result.contentFetchFailed, true);
  assert.equal(result.giveUp, true, 'must reach giveUp so the sweep skips the head');
  assert.equal(attempts, threshold, 'attempts the head exactly until the give-up threshold');
  assert.equal(backoffs, threshold - 1, 'backs off between attempts, not after the last');
});

test('transient failure that resolves is delivered without giving up', async () => {
  // Fails twice, then the content becomes available: delivered, never skipped.
  let n = 0;
  const attempt = async () => {
    n += 1;
    return n < 3 ? { contentFetchFailed: true } : { /* delivered */ };
  };
  const { result, attempts } = await deliverWithInSweepRetry(attempt, { maxAttempts: 10 });
  assert.ok(!result?.contentFetchFailed, 'delivered');
  assert.equal(attempts, 3);
});

test('delivered on the first attempt does not retry or back off', async () => {
  let backoffs = 0;
  const { result, attempts } = await deliverWithInSweepRetry(
    async () => ({ /* delivered */ }),
    { maxAttempts: 10, sleep: async () => { backoffs += 1; } },
  );
  assert.ok(!result?.contentFetchFailed);
  assert.equal(attempts, 1);
  assert.equal(backoffs, 0);
});

test('counter that never advances is bounded by maxAttempts (falls back to halt-ordering)', async () => {
  // Safety net: if the durable counter can't advance (e.g. seq already at/behind
  // the ledger watermark → recordContentFetchFailure is a no-op → giveUp never
  // fires), the loop must not spin forever — it stops at maxAttempts and returns
  // a still-transient result so the caller halts the sweep (PR#76 ordering).
  let attemptsMade = 0;
  const neverGivesUp = async () => { attemptsMade += 1; return { contentFetchFailed: true }; };
  const { result, attempts } = await deliverWithInSweepRetry(neverGivesUp, { maxAttempts: 4 });
  assert.equal(result.contentFetchFailed, true);
  assert.ok(!result.giveUp, 'never reached giveUp');
  assert.equal(attempts, 4, 'bounded by maxAttempts');
  assert.equal(attemptsMade, 4);
});

test('rejects an invalid maxAttempts', async () => {
  await assert.rejects(() => deliverWithInSweepRetry(async () => ({}), { maxAttempts: 0 }), TypeError);
  await assert.rejects(() => deliverWithInSweepRetry(async () => ({}), {}), TypeError);
});
