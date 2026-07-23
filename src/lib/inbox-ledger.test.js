import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

// Point RUNTIME_DIR (session.js: path.join(process.env.HOME, 'zylos/components/openmax/runtime'))
// at a throwaway HOME so the ledger's persisted file never touches a real
// component data dir. Must be set before importing the module under test.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-ledger-'));
process.env.HOME = tmpHome;
const RUNTIME_DIR = path.join(tmpHome, 'zylos/components/openmax/runtime');
const { createInboxLedger } = await import('./inbox-ledger.js');
const { createDeduper } = await import('./ws.js');
const { MAX_CONTENT_FETCH_ATTEMPTS } = await import('./content-fetch-giveup.js');

const noop = () => {};
function seedLedgerFile(slug, data) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(path.join(RUNTIME_DIR, `inbox-${slug}.json`), JSON.stringify(data));
}

test('resetReceived clears a prepare-phase-tainted dedupe set so the backlog re-dispatches (#79)', () => {
  // A comm-bridge started during the runtime prepare phase recorded inbox_seq 2
  // (the activation DM) but never delivered it — persisted as received=[2] with
  // acked_seq=0. On the real first boot the ledger loads that taint.
  seedLedgerFile('taint', { acked_seq: 0, received: [2] });
  const ledger = createInboxLedger('taint', { log: noop });

  // Before the fix: the replay would call record(2) and be deduped away.
  assert.equal(ledger.record(2), false, 'seq 2 is deduped by the tainted "received" set');

  // The first-boot path clears the taint; now the replay dispatches it.
  ledger.resetReceived();
  assert.equal(ledger.record(2), true, 'after resetReceived the activation DM re-dispatches');
});

test('resetReceived preserves the durable acked watermark', () => {
  seedLedgerFile('watermark', { acked_seq: 5, received: [7] });
  const ledger = createInboxLedger('watermark', { log: noop });

  assert.equal(ledger.getAckedSeq(), 5);
  ledger.resetReceived();
  assert.equal(ledger.getAckedSeq(), 5, 'acked_seq is untouched by resetReceived');
  // Anything at/below the watermark is still considered delivered (deduped)...
  assert.equal(ledger.record(5), false, 'seq <= acked_seq stays deduped');
  // ...while a fresh higher seq is accepted again (the received set was cleared).
  assert.equal(ledger.record(7), true, 'previously-seen higher seq is re-accepted after reset');
});

test('resetReceived on an empty ledger is a no-op', () => {
  const ledger = createInboxLedger('empty', { log: noop });
  assert.doesNotThrow(() => ledger.resetReceived());
  assert.equal(ledger.getAckedSeq(), 0);
});

test('first-boot recovery clears BOTH persisted taint layers (dedup.json + inbox ledger) — #79 P1', () => {
  // A comm-bridge started during the runtime prepare phase persisted the
  // activation DM into BOTH dedupe layers but never delivered it: the message-id
  // deduper (dedup.json) and the inbox-seq ledger (inbox-*.json). On the real
  // first boot the replay must clear both, or the message-id layer (checked
  // first, before the ledger) silently suppresses the backlog again.
  const dedupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zom-both-'));
  const dedupPath = path.join(dedupDir, 'dedup.json');
  fs.writeFileSync(dedupPath, JSON.stringify({ 'msg-activation': 1 }));
  seedLedgerFile('both', { acked_seq: 0, received: [7] });

  const dedupe = createDeduper({ persistPath: dedupPath });
  const ledger = createInboxLedger('both', { log: noop });

  // Before recovery: either layer alone would suppress the replay.
  assert.equal(dedupe('msg-activation'), true, 'id-dedupe suppresses (tainted dedup.json)');
  assert.equal(ledger.record(7), false, 'seq-ledger suppresses (tainted inbox ledger)');

  // First-boot recovery: forget the id + clear the ledger received set.
  dedupe.forget('msg-activation');
  ledger.resetReceived();

  // After recovery: the activation DM re-dispatches through both layers.
  assert.equal(dedupe('msg-activation'), false, 'id-dedupe now admits the activation DM');
  assert.equal(ledger.record(7), true, 'seq-ledger now admits the activation DM');
});

// ---------------------------------------------------------------------------
// Bounded content-fetch give-up (catch-up-wedge fix; follow-on to #79)
// ---------------------------------------------------------------------------

test('recordContentFetchFailure counts up and reports give-up at the cap', () => {
  const ledger = createInboxLedger('giveup-count', { log: noop });
  let r;
  for (let i = 0; i < MAX_CONTENT_FETCH_ATTEMPTS; i++) r = ledger.recordContentFetchFailure(1);
  assert.equal(r.failures, MAX_CONTENT_FETCH_ATTEMPTS);
  assert.equal(r.giveUp, true, 'gives up at the cap');
  // The failure BEFORE the cap must not give up.
  const ledger2 = createInboxLedger('giveup-count-2', { log: noop });
  for (let i = 0; i < MAX_CONTENT_FETCH_ATTEMPTS - 1; i++) r = ledger2.recordContentFetchFailure(1);
  assert.equal(r.giveUp, false, 'does not give up below the cap');
});

test('recordContentFetchFailure is a no-op at/behind the watermark', () => {
  seedLedgerFile('giveup-behind', { acked_seq: 5 });
  const ledger = createInboxLedger('giveup-behind', { log: noop });
  assert.equal(ledger.recordContentFetchFailure(5), null, 'seq == acked_seq is ignored');
  assert.equal(ledger.recordContentFetchFailure(3), null, 'seq < acked_seq is ignored');
  assert.equal(ledger.recordContentFetchFailure(0), null, 'non-positive seq is ignored');
});

test('the durable failure count SURVIVES a reload (cross-restart persistence)', () => {
  const slug = 'giveup-persist';
  const ledgerA = createInboxLedger(slug, { log: noop });
  // Two failures accumulate, then the process "restarts" (stop flushes to disk).
  ledgerA.recordContentFetchFailure(1);
  ledgerA.recordContentFetchFailure(1);
  assert.equal(ledgerA.getContentFetchFailureCount(1), 2);
  ledgerA.stop();

  // A fresh ledger loads the persisted file — the count continues, it does not
  // reset. Without this, an "empty head + repeated reconnect/restart" loop would
  // never reach the cap and the sweep would wedge forever.
  const ledgerB = createInboxLedger(slug, { log: noop });
  assert.equal(ledgerB.getContentFetchFailureCount(1), 2, 'count persisted across reload');
  // Continue accumulating toward the cap across the reload boundary.
  let r;
  for (let i = 2; i < MAX_CONTENT_FETCH_ATTEMPTS; i++) r = ledgerB.recordContentFetchFailure(1);
  assert.equal(r.failures, MAX_CONTENT_FETCH_ATTEMPTS);
  assert.equal(r.giveUp, true, 'reaches give-up after reload continues the count');
});

test('clearContentFetchFailure resets the counter (only consecutive failures count)', () => {
  const ledger = createInboxLedger('giveup-clear', { log: noop });
  ledger.recordContentFetchFailure(1);
  ledger.recordContentFetchFailure(1);
  assert.equal(ledger.getContentFetchFailureCount(1), 2);
  ledger.clearContentFetchFailure(1);
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'a successful fetch resets the count');
});

test('skip advances the watermark past an unfetchable head and clears its counter', () => {
  // received=[3,5,7] with acked_seq=0: the sweep is wedged waiting for seq 1/2.
  seedLedgerFile('giveup-skip', { acked_seq: 0, received: [3, 5, 7] });
  const ledger = createInboxLedger('giveup-skip', { log: noop });
  ledger.recordContentFetchFailure(1);
  assert.equal(ledger.getAckedSeq(), 0, 'still wedged before skip');

  ledger.skip(1);
  assert.equal(ledger.getAckedSeq(), 1, 'watermark advanced past the skipped head');
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'skipped seq counter cleared');

  // Once the gap behind it fills, the watermark runs on contiguously.
  ledger.record(2);
  assert.equal(ledger.getAckedSeq(), 3, 'watermark advances 2→3 once seq 2 arrives');
});

test('advancing the watermark prunes stale failure counters', () => {
  const ledger = createInboxLedger('giveup-prune', { log: noop });
  ledger.recordContentFetchFailure(1); // counter for seq 1
  // seq 1 later arrives successfully and the watermark advances over it.
  ledger.record(1);
  assert.equal(ledger.getAckedSeq(), 1);
  assert.equal(ledger.getContentFetchFailureCount(1), 0, 'consumed seq counter pruned');
});

test('reload drops failure counters for seqs already at/behind the watermark', () => {
  seedLedgerFile('giveup-load-prune', { acked_seq: 5, fetch_failures: { '3': 2, '7': 1 } });
  const ledger = createInboxLedger('giveup-load-prune', { log: noop });
  assert.equal(ledger.getContentFetchFailureCount(3), 0, 'stale (<=acked) counter dropped on load');
  assert.equal(ledger.getContentFetchFailureCount(7), 1, 'live (>acked) counter kept on load');
});
