/**
 * Event-driven runtime-metrics trigger.
 *
 * WHY: `runtime.state` (IDLE / BUSY / OFFLINE …) is what the platform reads to
 * decide whether an Agent can be talked to, but it only travels upward on the
 * runtime-metrics tick — 60s by default, plus a 15s initial delay. A freshly
 * provisioned Agent can therefore sit "greyed out" in the UI for up to a minute
 * after it is genuinely able to work. This watcher closes that window by firing
 * one extra report the moment the gate-relevant state actually changes.
 *
 * WHAT COUNTS AS A CHANGE — deliberately NOT every state transition. The local
 * execution state flaps between busy and idle constantly while an agent works
 * (observed in the readiness logs: busy → idle_too_brief → busy within seconds).
 * Reporting on every flap would turn a 1/min PUT into a continuous stream for a
 * working agent, which is a worse problem than the latency it fixes. So the
 * fingerprint is only what the platform's chat gate can act on:
 *
 *   - `ready`    — can this agent take work at all (readiness gate verdict)
 *   - `observable` — is a running agent process visible (distinguishes a
 *                    provisioning/absent agent from a present one)
 *
 * busy↔idle does not move either bit, so an agent grinding through a long task
 * produces no extra reports.
 *
 * The periodic tick is left exactly as it is: this only adds reports, never
 * removes them, so a missed edge still heals on the next tick.
 */

export const TRIGGER_DEFAULTS = {
  pollMs: 2000,     // matches the readiness gate's own cadence
  minGapMs: 5000,   // floor between event-driven reports, so a pathological flip cannot spam
};

/**
 * @param {object} deps
 * @param {() => {ready: boolean, reason: string}} deps.evaluate  readiness gate's one-shot check
 * @param {() => Promise<void>} deps.report                       the existing reportMetrics()
 * @param {(fn: Function, ms: number) => any} deps.setIntervalImpl
 * @param {() => number} deps.now
 * @param {() => object} [deps.options]
 */
export function createReadinessTrigger({
  evaluate, report, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  now = Date.now, options = () => ({}), log = () => {}, warn = () => {},
}) {
  let last = null;        // previous fingerprint, null until the first sample
  let lastReportAt = 0;
  let timer = null;
  let inflight = false;

  function settings() {
    return { ...TRIGGER_DEFAULTS, ...(options() || {}) };
  }

  /** Reduce the gate verdict to the two bits the platform can act on. */
  function fingerprint() {
    const v = evaluate();
    return {
      ready: v.ready === true,
      // `no_session` / `runtime_dead` / a missing status file all mean "no
      // observable agent process for this launch".
      observable: !['no_session', 'session_predates_launch', 'runtime_dead', 'status_missing', 'status_stale'].includes(v.reason),
      reason: v.reason,
    };
  }

  async function fire(fp, cause) {
    if (inflight) return;          // a slow PUT must not stack
    inflight = true;
    lastReportAt = now();
    try {
      log(`[readiness-trigger] state changed (${cause}) — reporting runtime-metrics immediately`);
      await report();
    } catch (err) {
      // The periodic tick remains the safety net, so a failed edge report is
      // not escalated beyond a warning.
      warn(`[readiness-trigger] immediate report failed: ${err.message}`);
    } finally {
      inflight = false;
    }
  }

  async function tick() {
    const cfg = settings();
    const fp = fingerprint();

    if (last === null) {
      // First sample establishes the baseline. Deliberately no report: the
      // reporter's own initial tick already covers process start.
      last = fp;
      return;
    }
    if (fp.ready === last.ready && fp.observable === last.observable) return;

    const cause = `ready ${last.ready}→${fp.ready}, observable ${last.observable}→${fp.observable} (${fp.reason})`;
    last = fp;
    if (now() - lastReportAt < cfg.minGapMs) {
      // Inside the floor — the periodic tick will carry it. Log so a suppressed
      // edge is visible rather than mysteriously absent.
      log(`[readiness-trigger] state changed (${cause}) but within ${cfg.minGapMs}ms floor — deferring to the periodic tick`);
      return;
    }
    await fire(fp, cause);
  }

  return {
    /** Exposed for tests and for a one-shot check. */
    tick,
    start() {
      if (timer) return;
      const { pollMs } = settings();
      timer = setIntervalImpl(() => { tick().catch(() => {}); }, pollMs);
      timer?.unref?.();
    },
    stop() {
      if (timer) { clearIntervalImpl(timer); timer = null; }
    },
  };
}
