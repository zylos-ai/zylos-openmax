/**
 * Agent readiness gate for the onboarding trigger.
 *
 * WHY: `online-report` is the server-side onboarding trigger (see
 * online-report.js). We fire it from WS `onOpen`, but the WebSocket coming up
 * only proves *this* process is alive — it says nothing about the runtime agent
 * behind C4. On a fresh install the comm-bridge can even be running while no
 * agent session exists at all (the `onOpen` first-connect branch already
 * documents that "prepare phase" window). Reporting then makes cws-core start
 * onboarding — welcome DM, seeded issues, an `active` onboarding session —
 * against an agent that cannot act for minutes, so the first real reply lands
 * long after the server believes onboarding began.
 *
 * WHAT COUNTS AS READY: not simply `state === 'idle'`. The activity monitor
 * defines idle as `activeTools === 0 && inactiveSeconds >= 3`
 * (monitor-orchestrator.js), and when no conversation file exists yet its
 * activity source degrades to `tmux_activity` and then to `default` — so a
 * still-booting runtime with no session reads `idle` just as a finished, waiting
 * one does. Idle alone would reopen the very hole this gate closes. We therefore
 * also require proof that a session actually reached its SessionStart hooks
 * *for the current runtime launch*: `foreground-session.json.observed_at >=
 * agent-status.json.runtime_launch_at` (the hook writes that file; a stale value
 * from a previous launch is rejected by the comparison).
 *
 * FAIL-OPEN BY DESIGN: the gate delays the trigger, it must never cancel it.
 * A permanently busy agent, a stopped activity monitor, or an unreadable status
 * file must not strand an org un-onboarded, so `waitUntilReady` gives up after
 * `maxWaitMs` and tells the caller to report anyway. Waiting forever would just
 * trade a latency bug for a deadlock. This mirrors C4's own fail-open reading of
 * the same status file.
 *
 * Deps are injected so the gate is unit-testable without an activity monitor.
 */

import path from 'node:path';
import os from 'node:os';
import { existsSync, statSync, readFileSync } from 'node:fs';

export const READINESS_DEFAULTS = {
  minIdleSeconds: 5,      // sustained idle before we believe the agent is waiting
  pollMs: 2000,           // status file is rewritten every ~1s
  maxWaitMs: 10 * 60_000, // hard cap, then report anyway (see FAIL-OPEN above)
  staleStatusMs: 30_000,  // older than this ⇒ monitor not writing ⇒ unknown, not ready
};

/**
 * @param {object} deps
 * @param {() => ({data: object, mtimeMs: number}|null)} deps.readStatus     agent-status.json
 * @param {() => (object|null)} deps.readForeground                          foreground-session.json
 * @param {() => (object|null)} deps.readProc                                proc-state.json
 * @param {(ms: number) => Promise<void>} deps.sleep
 * @param {() => number} deps.now                                           epoch ms
 * @param {() => object} [deps.options]                                     overrides, read per call
 */
export function createReadinessGate({ readStatus, readForeground, readProc, sleep, now, options = () => ({}) }) {
  function settings() {
    return { ...READINESS_DEFAULTS, ...(options() || {}) };
  }

  /** One-shot check. Returns `{ready, reason}`; `reason` names the blocker. */
  function evaluate() {
    const cfg = settings();

    const status = readStatus();
    if (!status?.data) return { ready: false, reason: 'status_missing' };
    if (now() - status.mtimeMs > cfg.staleStatusMs) return { ready: false, reason: 'status_stale' };

    const s = status.data;
    if (typeof s.health === 'string' && s.health !== 'ok') return { ready: false, reason: `health_${s.health}` };
    if (s.state !== 'idle') return { ready: false, reason: 'busy' };
    if ((s.idle_seconds ?? 0) < cfg.minIdleSeconds) return { ready: false, reason: 'idle_too_brief' };

    // A session must have started, and started within THIS runtime launch.
    const fg = readForeground();
    const observedAt = Number(fg?.observed_at) || 0;
    if (!observedAt) return { ready: false, reason: 'no_session' };
    const launchAt = Number(s.runtime_launch_at) || 0;
    if (launchAt && observedAt < launchAt) return { ready: false, reason: 'session_predates_launch' };

    // proc-state is advisory: absent/stale ⇒ don't block on it, but a confirmed
    // dead runtime means the idle reading above is meaningless.
    const proc = readProc();
    if (proc && proc.alive === false) return { ready: false, reason: 'runtime_dead' };

    return { ready: true, reason: 'ready' };
  }

  /**
   * Poll until ready or until the cap elapses.
   * @returns {Promise<{ready: boolean, reason: string, waitedMs: number, timedOut: boolean}>}
   */
  async function waitUntilReady({ onWait } = {}) {
    const cfg = settings();
    const startedAt = now();
    let announced = null;

    for (;;) {
      const verdict = evaluate();
      const waitedMs = now() - startedAt;
      if (verdict.ready) return { ...verdict, waitedMs, timedOut: false };

      // Report the blocker once per distinct reason — a poll loop must not
      // become a log firehose.
      if (onWait && verdict.reason !== announced) {
        announced = verdict.reason;
        onWait(verdict.reason, waitedMs);
      }

      if (waitedMs + cfg.pollMs > cfg.maxWaitMs) {
        return { ready: false, reason: verdict.reason, waitedMs, timedOut: true };
      }
      await sleep(cfg.pollMs);
    }
  }

  return { evaluate, waitUntilReady };
}

/**
 * Wrap the online-reporter so the trigger waits for a ready agent.
 *
 * One waiter per org: a periodic retry tick must not stack a second poll loop
 * behind the one the WS open already started. The underlying reporter's own Set
 * makes the POST idempotent — this guards the *wait*, not the POST.
 *
 * @param {object} deps
 * @param {(orgConfig: object) => Promise<void>} deps.reportAgentOnline
 * @param {{waitUntilReady: Function}} deps.gate
 * @param {() => boolean} [deps.isDisabled]  bypass the gate entirely (config escape hatch)
 */
export function createGatedOnlineReporter({ reportAgentOnline, gate, isDisabled = () => false, log = () => {}, warn = () => {} }) {
  const waiting = new Set();

  return async function reportAgentOnlineWhenReady(orgConfig) {
    const { slug } = orgConfig;
    if (waiting.has(slug)) return;
    waiting.add(slug);
    try {
      if (isDisabled()) {
        await reportAgentOnline(orgConfig);
        return;
      }
      const verdict = await gate.waitUntilReady({
        onWait: (reason, waitedMs) =>
          log(`[${slug}] online-report held: agent not ready (${reason}, waited ${Math.round(waitedMs / 1000)}s)`),
      });
      if (verdict.timedOut) {
        // Cap reached. Report anyway — a delayed onboarding beats an org that
        // never onboards because its agent stayed busy.
        warn(`[${slug}] agent still not ready after ${Math.round(verdict.waitedMs / 1000)}s (${verdict.reason}) — reporting online anyway`);
      } else if (verdict.waitedMs > 0) {
        log(`[${slug}] agent ready after ${Math.round(verdict.waitedMs / 1000)}s — reporting online`);
      }
      await reportAgentOnline(orgConfig);
    } finally {
      waiting.delete(slug);
    }
  };
}

/** Default wiring against the activity monitor's on-disk state. */
export function createDefaultReadinessGate({ options } = {}) {
  const zylosDir = process.env.ZYLOS_DIR || path.join(process.env.HOME || os.homedir(), 'zylos');
  const monitorDir = path.join(zylosDir, 'activity-monitor');
  const statusFile = path.join(monitorDir, 'agent-status.json');
  const foregroundFile = path.join(monitorDir, 'foreground-session.json');
  const procFile = path.join(monitorDir, 'proc-state.json');

  // These files are rewritten atomically every second; a torn read is expected
  // occasionally and simply means "unknown this tick", never "not ready forever".
  const readJson = (file) => {
    try {
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  return createReadinessGate({
    readStatus: () => {
      try {
        if (!existsSync(statusFile)) return null;
        const mtimeMs = statSync(statusFile).mtimeMs;
        const data = readJson(statusFile);
        return data ? { data, mtimeMs } : null;
      } catch {
        return null;
      }
    },
    readForeground: () => readJson(foregroundFile),
    readProc: () => readJson(procFile),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    options,
  });
}
