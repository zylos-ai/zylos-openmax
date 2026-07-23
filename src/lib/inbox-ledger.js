/**
 * Inbox-seq ledger — per-org persistent tracking of received inbox sequences.
 *
 * Maintains a continuous-ack watermark (acked_seq) and a set of received-but-
 * not-yet-contiguous sequences. A periodic timer advances the watermark,
 * triggers ackSync, and detects gaps that need /sync backfill.
 *
 * File: runtime/inbox-{orgSlug}.json
 * Schema: { acked_seq: number, received: number[], fetch_failures: { [seq]: number } }
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';
import { recordFailure, clearFailure, failureCount } from './content-fetch-giveup.js';

const TICK_INTERVAL_MS = 5_000;
const GAP_TIMEOUT_MS = 10_000;
const RECEIVED_CAP = 5000;
const PERSIST_DEBOUNCE_MS = 1_000;

export function createInboxLedger(orgSlug, { onAck, onGapSync, log }) {
  const filePath = path.join(RUNTIME_DIR, `inbox-${orgSlug}.json`);

  let ackedSeq = 0;
  let lastAckedSeq = 0;
  const received = new Set();
  // Durable per-seq consecutive content-fetch-failure counts ({ [seq]: n }).
  // Persisted alongside acked_seq so a permanently-unfetchable head keeps
  // accumulating failures ACROSS process restarts + reconnects (the wedge's
  // signature is repeated connect→restart→reconnect legs); an in-memory-only
  // counter would reset each restart and never reach the give-up threshold.
  let fetchFailures = {};
  let oldestGapTs = null;
  let persistTimer = null;
  let tickTimer = null;

  function pruneFetchFailures() {
    // A counter is only meaningful for a seq still ahead of the watermark;
    // once acked/skipped, drop it.
    for (const k of Object.keys(fetchFailures)) {
      if (Number(k) <= ackedSeq) delete fetchFailures[k];
    }
  }

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
      if (data.fetch_failures && typeof data.fetch_failures === 'object') {
        for (const [k, v] of Object.entries(data.fetch_failures)) {
          if (Number.isInteger(v) && v > 0 && Number(k) > ackedSeq) fetchFailures[k] = v;
        }
      }
      log(`inbox-ledger loaded: acked_seq=${ackedSeq} pending=${received.size} fetch_failures=${Object.keys(fetchFailures).length}`);
    } catch {
      // No file or corrupt — start fresh; ackedSeq will be set from sync_seq.
    }
  }

  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      const sorted = [...received].sort((a, b) => a - b);
      const data = { acked_seq: ackedSeq, received: sorted, fetch_failures: fetchFailures };
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
      pruneFetchFailures();
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
    const data = { acked_seq: ackedSeq, received: sorted, fetch_failures: fetchFailures };
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(data));
    } catch {}
  }

  /**
   * Drop the received-but-not-yet-contiguous set without touching the
   * continuous-ack watermark. Used by the first-boot replay path: a comm-bridge
   * started transiently during the runtime prepare phase can record inbox seqs
   * it never delivered to an agent session (no session exists yet), tainting the
   * dedupe set. On a genuine first boot nothing has been delivered, so those
   * stale "seen" marks must not suppress the replay-and-dispatch. acked_seq is
   * left untouched (it is the durable delivered watermark, seeded separately).
   */
  function resetReceived() {
    if (received.size === 0) return;
    received.clear();
    oldestGapTs = null;
    persist();
  }

  function setAckedSeq(seq) {
    if (typeof seq === 'number' && seq > ackedSeq) {
      ackedSeq = seq;
      lastAckedSeq = seq;
      for (const s of received) {
        if (s <= ackedSeq) received.delete(s);
      }
      pruneFetchFailures();
      persist();
    }
  }

  function getAckedSeq() { return ackedSeq; }

  /**
   * Record one DURABLE, cross-restart content-fetch failure for `seq` and
   * report whether the caller should give up on it now. The count is persisted
   * in this ledger's file so it keeps accumulating across process restarts and
   * reconnects (the catch-up-wedge signature). Returns
   * { failures, giveUp, max } — see content-fetch-giveup.recordFailure. A no-op
   * (returns null) for seqs already at/behind the watermark.
   */
  function recordContentFetchFailure(seq) {
    if (typeof seq !== 'number' || seq <= 0 || seq <= ackedSeq) return null;
    const result = recordFailure(fetchFailures, seq);
    persist();
    return result;
  }

  /** Clear a seq's consecutive content-fetch-failure counter (on success). */
  function clearContentFetchFailure(seq) {
    if (clearFailure(fetchFailures, seq)) persist();
  }

  /** Current durable consecutive content-fetch-failure count for `seq`. */
  function getContentFetchFailureCount(seq) {
    return failureCount(fetchFailures, seq);
  }

  /**
   * Give-up path: mark `seq` as permanently consumed even though it was never
   * successfully processed (content unavailable after the give-up threshold).
   * Adds it to the received set, advances the watermark, and clears its failure
   * counter — so the gap-detector stops re-triggering /sync on this unfetchable
   * head forever and the backlog behind it can be delivered.
   */
  function skip(seq) {
    if (typeof seq !== 'number' || seq <= 0 || seq <= ackedSeq) return;
    received.add(seq);
    clearFailure(fetchFailures, seq);
    advanceWatermark();
    persist();
  }

  load();

  return {
    record, start, stop, setAckedSeq, getAckedSeq, resetReceived,
    recordContentFetchFailure, clearContentFetchFailure, getContentFetchFailureCount, skip,
  };
}
