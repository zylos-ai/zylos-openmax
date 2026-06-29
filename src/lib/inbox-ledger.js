/**
 * Inbox-seq ledger — per-org persistent tracking of received inbox sequences.
 *
 * Maintains a continuous-ack watermark (acked_seq) and a set of received-but-
 * not-yet-contiguous sequences. A periodic timer advances the watermark,
 * triggers ackSync, and detects gaps that need /sync backfill.
 *
 * File: runtime/inbox-{orgSlug}.json
 * Schema: { acked_seq: number, received: number[] }
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

const TICK_INTERVAL_MS = 5_000;
const GAP_TIMEOUT_MS = 10_000;
const RECEIVED_CAP = 5000;
const PERSIST_DEBOUNCE_MS = 1_000;

export function createInboxLedger(orgSlug, { onAck, onGapSync, log }) {
  const filePath = path.join(RUNTIME_DIR, `inbox-${orgSlug}.json`);

  let ackedSeq = 0;
  let lastAckedSeq = 0;
  const received = new Set();
  let oldestGapTs = null;
  let persistTimer = null;
  let tickTimer = null;

  function load() {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (typeof data.acked_seq === 'number' && data.acked_seq > 0) {
        ackedSeq = data.acked_seq;
      }
      if (Array.isArray(data.received)) {
        for (const s of data.received) {
          if (typeof s === 'number' && s > ackedSeq) received.add(s);
        }
      }
      log(`inbox-ledger loaded: acked_seq=${ackedSeq} pending=${received.size}`);
    } catch {
      // No file or corrupt — start fresh; ackedSeq will be set from sync_seq.
    }
  }

  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const sorted = [...received].sort((a, b) => a - b);
      const data = { acked_seq: ackedSeq, received: sorted };
      const tmp = `${filePath}.tmp.${process.pid}`;
      try {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(data));
        fs.renameSync(tmp, filePath);
      } catch (err) {
        try { fs.unlinkSync(tmp); } catch {}
        log(`inbox-ledger persist failed: ${err.message}`);
      }
    }, PERSIST_DEBOUNCE_MS);
  }

  function advanceWatermark() {
    let advanced = false;
    while (received.has(ackedSeq + 1)) {
      ackedSeq += 1;
      received.delete(ackedSeq);
      advanced = true;
    }
    if (advanced) {
      oldestGapTs = null;
    }
    return advanced;
  }

  /**
   * Record a received inbox_seq. Returns false if it was already known
   * (duplicate), true if it's new and should be processed.
   */
  function record(inboxSeq) {
    if (typeof inboxSeq !== 'number' || inboxSeq <= 0) return true;
    if (inboxSeq <= ackedSeq) return false;
    if (received.has(inboxSeq)) return false;
    received.add(inboxSeq);
    advanceWatermark();
    persist();
    return true;
  }

  function tick() {
    advanceWatermark();
    if (ackedSeq > lastAckedSeq) {
      lastAckedSeq = ackedSeq;
      persist();
      if (onAck) onAck(ackedSeq);
    }

    if (received.size > 0) {
      if (received.size > RECEIVED_CAP) {
        log(`inbox-ledger: received set overflow (${received.size}), triggering /sync`);
        received.clear();
        oldestGapTs = null;
        persist();
        if (onGapSync) onGapSync(ackedSeq);
        return;
      }
      if (!oldestGapTs) {
        oldestGapTs = Date.now();
      } else if (Date.now() - oldestGapTs > GAP_TIMEOUT_MS) {
        log(`inbox-ledger: gap persisted ${Math.round((Date.now() - oldestGapTs) / 1000)}s, triggering /sync from ${ackedSeq}`);
        oldestGapTs = Date.now();
        if (onGapSync) onGapSync(ackedSeq);
      }
    } else {
      oldestGapTs = null;
    }
  }

  function start() {
    if (tickTimer) return;
    tickTimer = setInterval(tick, TICK_INTERVAL_MS);
    if (tickTimer.unref) tickTimer.unref();
  }

  function stop() {
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    // Final synchronous persist
    const sorted = [...received].sort((a, b) => a - b);
    const data = { acked_seq: ackedSeq, received: sorted };
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data));
    } catch {}
  }

  function setAckedSeq(seq) {
    if (typeof seq === 'number' && seq > ackedSeq) {
      ackedSeq = seq;
      lastAckedSeq = seq;
      for (const s of received) {
        if (s <= ackedSeq) received.delete(s);
      }
      persist();
    }
  }

  function getAckedSeq() { return ackedSeq; }

  load();

  return { record, start, stop, setAckedSeq, getAckedSeq };
}
