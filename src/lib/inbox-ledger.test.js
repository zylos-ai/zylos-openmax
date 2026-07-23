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
