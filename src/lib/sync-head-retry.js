/**
 * In-sweep retry of a content-fetch-failing catch-up head.
 *
 * Why this exists
 * ---------------
 * The durable give-up counter (content-fetch-giveup.js, persisted in the
 * inbox-ledger) only advances when the /sync catch-up path RE-ATTEMPTS a
 * failing message's content fetch. But a `fromStart` sweep only runs on a WS
 * (re)connect: the first-boot replay from `onOpen`, or a reconnect. On a STABLE
 * long-lived connection with `sync_seq` still stuck at 0, no further sweep ever
 * runs — the in-connection gap-detector takes the non-`fromStart` path, which
 * returns early while `sync_seq` is 0. So a single sweep would halt on a
 * permanently-unfetchable HEAD at failure #1 and, with no reconnect to fire
 * another sweep, wait forever: the whole backlog behind the bad head is never
 * delivered (the catch-up wedge; follow-on to #79 / PR#76).
 *
 * The fix: within one sweep, re-attempt the SAME failing head (never advancing
 * past it — seq ordering preserved) until it either resolves or the durable
 * give-up threshold is reached. That drives the counter to its cap inside a
 * single sweep, independent of reconnects, so the head is skipped and the
 * backlog flows — which is exactly the "stable connection + permanent empty
 * head" scenario the wedge is.
 *
 * A `maxAttempts` hard cap bounds the loop as a safety net for the case where
 * the counter CANNOT advance (e.g. the seq is already at/behind the ledger
 * watermark, so `recordContentFetchFailure` is a no-op and `giveUp` never
 * fires). In that case the caller falls back to PR#76 halt-ordering rather than
 * spinning. `maxAttempts` should comfortably exceed the give-up threshold
 * (MAX_CONTENT_FETCH_ATTEMPTS) so the normal path ends on `giveUp`, not the cap.
 *
 * Pure and side-effect-free: all effects (the actual fetch/dispatch, the
 * backoff sleep) are injected, so the loop is unit-testable in isolation — the
 * reviewer's acceptance case ("stable connection, no reconnect, permanent empty
 * head → head skipped, backlog delivered") is covered by driving `attempt` with
 * a stub that mimics the durable counter.
 */

/**
 * @typedef {{ contentFetchFailed?: boolean, giveUp?: boolean }} DispatchResult
 */

/**
 * Repeatedly invoke `attempt` for a single catch-up event until it is delivered
 * or the give-up threshold is reached, backing off between transient failures.
 *
 * @param {() => Promise<DispatchResult|undefined>} attempt  Dispatch the event
 *   once (fetch content + hand to the agent). Returns the handler result: a
 *   falsy `contentFetchFailed` means delivered; `giveUp:true` means the durable
 *   counter hit its cap and the handler already skipped it.
 * @param {object} opts
 * @param {number} opts.maxAttempts  Hard cap on attempts (safety net; must be
 *   a positive integer and should exceed the give-up threshold).
 * @param {() => Promise<void>} [opts.sleep]  Backoff between transient retries.
 *   Defaulted to a no-op so callers/tests can opt out of waiting.
 * @returns {Promise<{ result: DispatchResult|undefined, attempts: number }>}
 *   The final handler result and how many times `attempt` was invoked.
 */
export async function deliverWithInSweepRetry(attempt, { maxAttempts, sleep } = {}) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError(`sync-head-retry: maxAttempts must be a positive integer, got ${maxAttempts}`);
  }
  const backoff = typeof sleep === 'function' ? sleep : async () => {};
  let attempts = 0;
  for (;;) {
    const result = await attempt();
    attempts += 1;
    // Delivered, or the give-up threshold was reached (handler already skipped
    // it): stop retrying.
    if (!result?.contentFetchFailed || result.giveUp) return { result, attempts };
    // Transient failure below the cap: brief backoff, then re-attempt the SAME
    // event. Never advance past it — seq ordering is preserved.
    if (attempts >= maxAttempts) return { result, attempts };
    await backoff();
  }
}
