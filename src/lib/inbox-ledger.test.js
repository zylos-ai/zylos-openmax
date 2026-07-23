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
