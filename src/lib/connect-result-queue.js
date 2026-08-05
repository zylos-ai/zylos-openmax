/**
 * Durable queue for undelivered connect-results.
 *
 * A channel binding stays `pending` until its result is recorded, and a pending
 * binding is exactly what leaves the workspace UI spinning with no way to
 * retry. The connector already retries the POST with backoff
 * (channel-connector.js), but a result that outlives those attempts — a longer
 * outage, or a crash/restart mid-flight — must not be dropped: the channel is
 * connected and serving while the record says otherwise.
 *
 * So anything the connector could not deliver is written to disk and re-sent
 * until it lands. Deliberately a plain JSON file, not a database: the queue is
 * tiny, write amplification is irrelevant at one entry per connect command, and
 * a file survives a restart, which is the whole point.
 *
 * Pure logic + injectable I/O so the retry/resend path is unit-testable — the
 * previous version lived inline in comm-bridge.js, where it could not be tested
 * and shipped with an undefined path constant that crashed the service on boot.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

export const CONNECT_RESULT_QUEUE_FILE = path.join(RUNTIME_DIR, 'pending-connect-results.json');
export const CONNECT_RESULT_RESEND_INTERVAL_MS = 60 * 1000;
export const CONNECT_RESULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;  // stop trying after a day
export const CONNECT_RESULT_QUEUE_MAX = 200;

/** One entry per binding+request: re-reporting the same command is pointless. */
const entryKey = (x) => `${x.bindingId}:${x.requestId || ''}`;

/**
 * @param {object}   [deps]
 * @param {string}   [deps.file]        queue file path
 * @param {(item) => Promise<void>} deps.sendResult  delivers one queued result
 * @param {() => number} [deps.now]     clock (injectable for age tests)
 * @param {object}   [deps.fsDep]       fs module (injectable)
 * @param {function} [deps.log] @param {function} [deps.warn]
 * @param {number}   [deps.maxAgeMs] @param {number} [deps.maxItems]
 */
export function createConnectResultQueue({
  file = CONNECT_RESULT_QUEUE_FILE,
  sendResult,
  now = Date.now,
  fsDep = fs,
  log = () => {},
  warn = () => {},
  maxAgeMs = CONNECT_RESULT_MAX_AGE_MS,
  maxItems = CONNECT_RESULT_QUEUE_MAX,
} = {}) {
  // A corrupt or absent file must never take the service down — an empty queue
  // is the correct reading of "nothing recoverable on disk".
  const read = () => {
    try {
      const parsed = JSON.parse(fsDep.readFileSync(file, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };

  const write = (items) => {
    try {
      fsDep.mkdirSync(path.dirname(file), { recursive: true });
      // 0600: a result payload names the org and binding being connected.
      fsDep.writeFileSync(file, JSON.stringify(items, null, 2), { mode: 0o600 });
      return true;
    } catch (e) {
      warn(`could not persist connect-result queue: ${e.message}`);
      return false;
    }
  };

  /** Persist a result the connector could not deliver. Never throws. */
  const queue = (r) => {
    // A newer result for the same binding+request supersedes the older one.
    const next = read().filter((x) => entryKey(x) !== entryKey(r));
    next.push({ ...r, queuedAt: now() });
    // Cap from the front: the newest results are the ones worth keeping.
    write(next.slice(-maxItems));
    warn(`connect-result queued for resend binding=${r.bindingId} status=${r.status}`);
  };

  // Single-flight for resend. Every run does read-modify-write on one file, so
  // two overlapping runs would each re-send the entries the other is still
  // working through and then clobber each other's rewrite — losing results this
  // queue exists to guarantee. The timer that drives it does not await anything,
  // so a run slower than the interval is not hypothetical.
  let inFlight = null;

  /**
   * Try every queued result once; keep the ones that still fail. Never throws —
   * it runs from a timer, and a resend failure is expected, not exceptional.
   * A call made while a previous run is still going joins that run rather than
   * starting a second one.
   * @returns {Promise<{sent: number, kept: number, dropped: number}>}
   */
  const resend = async () => {
    if (inFlight) return inFlight;
    inFlight = runResend().finally(() => { inFlight = null; });
    return inFlight;
  };

  const runResend = async () => {
    const items = read();
    if (!items.length) return { sent: 0, kept: 0, dropped: 0 };
    const keep = [];
    let sent = 0, dropped = 0;
    for (const item of items) {
      if (now() - (item.queuedAt || 0) > maxAgeMs) {
        // Past this age the binding has almost certainly been re-driven by the
        // user; re-reporting a day-old result would be worse than dropping it.
        warn(`dropping connect-result older than 24h binding=${item.bindingId} status=${item.status}`);
        dropped++;
        continue;
      }
      try {
        await sendResult(item);
        log(`connect-result resend succeeded binding=${item.bindingId} status=${item.status}`);
        sent++;
      } catch (e) {
        warn(`connect-result resend failed binding=${item.bindingId}: ${e.message}`);
        keep.push(item);
      }
    }
    // Only rewrite when the contents actually changed, so a run where every
    // resend fails leaves the file (and its queuedAt stamps) untouched.
    if (sent || dropped) write(keep);
    return { sent, kept: keep.length, dropped };
  };

  return { queue, resend, read, file };
}
