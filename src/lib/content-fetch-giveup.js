/**
 * Bounded content-fetch give-up decision.
 *
 * Problem this solves
 * -------------------
 * When a WS "message" frame's body can't be fetched (GET fails / returns no
 * usable body), the comm-bridge deliberately does NOT forward an empty message
 * and does NOT advance the /sync cursor — it leaves the message "unconsumed" so
 * the next catch-up re-pulls it in seq order (PR#76 ordering preservation).
 *
 * That is correct for a TRANSIENT failure. But for a message that is
 * PERMANENTLY unfetchable (e.g. an onboarding welcome DM seeded with an EMPTY
 * body at inbox seq 1), the first-boot /sync sweep halts on it forever: the
 * inbox-ledger gap-detector re-triggers /sync every ~10-15s, each retry re-hits
 * the same empty head and halts again, and the entire backlog behind it (the
 * activation DM included) is never delivered (follow-on to #79 / PR#76).
 *
 * This module adds a bounded give-up: it counts CONSECUTIVE content-fetch
 * failures per message key. After `max` consecutive failures the caller should
 * GIVE UP on that one message — skip past it, advance the ledger watermark, and
 * alarm-log — so the rest of the backlog flows. A successful fetch resets the
 * counter, so only truly-consecutive failures accumulate. Keys are independent,
 * so one wedged message never affects another's budget.
 *
 * Pure and stateless: every function operates on a caller-owned plain-object
 * `counts` map ({ [key]: number }). The caller (inbox-ledger) persists that map
 * to disk so the count SURVIVES process restarts and reconnects — the wedge's
 * signature is "WS connect → restart → reconnect ~29s later" repeated, so an
 * in-memory-only counter would reset every restart and never reach `max`. A
 * plain-object map is trivially JSON-serializable for that durable persistence.
 * Keeping the logic here (not in comm-bridge.js, which runs side-effects on
 * import and isn't directly unit-testable) makes it unit-testable in isolation.
 */

// Consecutive content-fetch failures tolerated for a single message before the
// caller gives up and skips it. Kept small: a handful of retries across reconnect
// backoff is plenty to ride out a transient GET failure, while still bounding
// how long a permanently-unfetchable head can wedge the catch-up sweep.
export const MAX_CONTENT_FETCH_ATTEMPTS = 5;

/**
 * Record one content-fetch failure for `key` in the caller-owned `counts` map,
 * mutating it in place, and decide whether the caller should give up now.
 *
 * @param {Record<string, number>} counts caller-owned, persisted failure map.
 * @param {string|number} key   message key (inbox seq or message id).
 * @param {number} [max=MAX_CONTENT_FETCH_ATTEMPTS] give-up threshold.
 * @returns {{ key: string, failures: number, giveUp: boolean, max: number }}
 *   `failures` is the new consecutive count; `giveUp` is true once it reaches
 *   `max`.
 */
export function recordFailure(counts, key, max = MAX_CONTENT_FETCH_ATTEMPTS) {
  if (!Number.isInteger(max) || max < 1) {
    throw new TypeError(`content-fetch-giveup: max must be a positive integer, got ${max}`);
  }
  const k = String(key);
  const n = (counts[k] || 0) + 1;
  counts[k] = n;
  return { key: k, failures: n, giveUp: n >= max, max };
}

/**
 * Clear the consecutive-failure counter for `key` after a successful fetch (or
 * after giving up on it). Mutates `counts` in place. Returns true if a counter
 * existed.
 */
export function clearFailure(counts, key) {
  const k = String(key);
  if (Object.prototype.hasOwnProperty.call(counts, k)) {
    delete counts[k];
    return true;
  }
  return false;
}

/** Current consecutive-failure count for `key` (0 if none). */
export function failureCount(counts, key) {
  return counts[String(key)] || 0;
}
