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
  heartbeatMs: 30_000,    // while held, re-log at this cadence so a long wait is visible
};

/**
 * Public config (`agent.readiness_gate` in config.json) is snake_case, like every
 * other key in this file's neighbours (`device_id`, `api_key`,
 * `heartbeat_interval`). Internals are camelCase. Normalize at the boundary
 * rather than letting the two shapes meet: merging raw config into camelCase
 * defaults silently dropped every documented timing knob, so an operator
 * lowering the 10-minute cap kept getting 10 minutes with no error to show why.
 *
 * camelCase is accepted too, for programmatic/test callers. Non-numeric or
 * non-positive values are ignored rather than propagated — a NaN reaching
 * `maxWaitMs` would disable the fail-open cap, and a NaN `pollMs` would turn the
 * wait into a busy spin.
 */
const OPTION_ALIASES = {
  min_idle_seconds: 'minIdleSeconds',
  poll_ms: 'pollMs',
  max_wait_ms: 'maxWaitMs',
  stale_status_ms: 'staleStatusMs',
  heartbeat_ms: 'heartbeatMs',
};

export function normalizeReadinessOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const [key, value] of Object.entries(raw)) {
    const name = OPTION_ALIASES[key] || key;
    if (!(name in READINESS_DEFAULTS)) continue; // unknown key (e.g. `enabled`) — not ours
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) continue; // garbage in config must not break the loop
    out[name] = n;
  }
  return out;
}

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
    return { ...READINESS_DEFAULTS, ...normalizeReadinessOptions(options()) };
  }

  /**
   * One-shot check.
   * @returns {{ready: boolean, reason: string, detail: object}} `reason` names the
   *   blocker; `detail` is the observed snapshot, carried so the caller can log
   *   *why* without re-reading the files (this gate is diagnosed from logs on
   *   machines we don't have shell access to).
   */
  function evaluate() {
    const cfg = settings();

    const status = readStatus();
    if (!status?.data) return { ready: false, reason: 'status_missing', detail: { status_file: 'missing_or_unreadable' } };

    const s = status.data;
    const statusAgeMs = now() - status.mtimeMs;
    const fg = readForeground();
    const proc = readProc();
    const observedAt = Number(fg?.observed_at) || 0;
    const launchAt = Number(s.runtime_launch_at) || 0;

    // Snapshot every input the verdict depends on, so one log line explains it.
    const detail = {
      state: s.state ?? null,
      idle_seconds: s.idle_seconds ?? null,
      health: s.health ?? null,
      status_age_ms: statusAgeMs,
      session_observed_at: observedAt || null,
      runtime_launch_at: launchAt || null,
      session_in_launch: observedAt ? (!launchAt || observedAt >= launchAt) : false,
      proc_alive: proc ? proc.alive !== false : null,
      session_id: fg?.session_id ?? null,
    };
    const verdict = (ready, reason) => ({ ready, reason, detail });

    // Order is by diagnostic value, not convenience: when several conditions
    // fail at once we must name the most fundamental one. During boot both
    // "no session yet" and "idle for <5s" are true, and reporting the latter
    // would hide the fact that there is no session at all.
    if (statusAgeMs > cfg.staleStatusMs) return verdict(false, 'status_stale');
    if (typeof s.health === 'string' && s.health !== 'ok') return verdict(false, `health_${s.health}`);

    // A session must have started, and started within THIS runtime launch.
    if (!observedAt) return verdict(false, 'no_session');
    if (!detail.session_in_launch) return verdict(false, 'session_predates_launch');

    // proc-state is advisory: absent/stale ⇒ don't block on it, but a confirmed
    // dead runtime means any idle reading is meaningless.
    if (detail.proc_alive === false) return verdict(false, 'runtime_dead');

    if (s.state !== 'idle') return verdict(false, 'busy');
    if ((s.idle_seconds ?? 0) < cfg.minIdleSeconds) return verdict(false, 'idle_too_brief');

    return verdict(true, 'ready');
  }

  /**
   * Poll until ready or until the cap elapses.
   *
   * `onWait({reason, detail, waitedMs, kind})` fires on the first block, on every
   * change of blocker, and on a slow heartbeat while still blocked. The heartbeat
   * matters: without it a long hold logs one line and then goes silent, which is
   * indistinguishable from a hung process to whoever is reading the log.
   *
   * @returns {Promise<{ready, reason, detail, waitedMs, timedOut, polls}>}
   */
  async function waitUntilReady({ onWait } = {}) {
    const cfg = settings();
    const startedAt = now();
    let announcedReason = null;
    let lastHeartbeatAt = startedAt;
    let polls = 0;

    for (;;) {
      const v = evaluate();
      const waitedMs = now() - startedAt;
      if (v.ready) return { ...v, waitedMs, timedOut: false, polls };

      // A poll loop must not become a log firehose: emit on state change, then
      // only once per heartbeat interval.
      if (onWait) {
        const changed = v.reason !== announcedReason;
        const dueForHeartbeat = now() - lastHeartbeatAt >= cfg.heartbeatMs;
        if (changed || dueForHeartbeat) {
          announcedReason = v.reason;
          lastHeartbeatAt = now();
          onWait({ reason: v.reason, detail: v.detail, waitedMs, kind: changed ? 'blocked' : 'still_blocked' });
        }
      }

      if (waitedMs + cfg.pollMs > cfg.maxWaitMs) {
        return { ...v, waitedMs, timedOut: true, polls };
      }
      polls++;
      await sleep(cfg.pollMs);
    }
  }

  return { evaluate, waitUntilReady };
}

/**
 * Render a readiness snapshot as one compact, greppable log field set.
 * Kept next to `evaluate` so the two never drift apart.
 */
export function formatReadinessDetail(detail = {}) {
  if (detail.status_file) return `status_file=${detail.status_file}`;
  const parts = [
    `state=${detail.state}`,
    `idle=${detail.idle_seconds}s`,
    `health=${detail.health}`,
    `status_age=${Math.round((detail.status_age_ms ?? 0) / 1000)}s`,
    `session=${detail.session_observed_at ? (detail.session_in_launch ? 'in-launch' : 'predates-launch') : 'none'}`,
  ];
  if (detail.proc_alive !== null && detail.proc_alive !== undefined) parts.push(`proc=${detail.proc_alive ? 'alive' : 'dead'}`);
  if (detail.session_id) parts.push(`session_id=${detail.session_id}`);
  return parts.join(' ');
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
 * @param {() => boolean} [deps.isDisabled]           bypass the gate entirely (config escape hatch)
 * @param {(slug: string) => boolean} [deps.isAlreadyReported]  org has nothing left to report
 */
export function createGatedOnlineReporter({ reportAgentOnline, gate, isDisabled = () => false, isAlreadyReported = () => false, log = () => {}, warn = () => {} }) {
  const waiting = new Set();
  const secs = (ms) => `${Math.round(ms / 1000)}s`;

  return async function reportAgentOnlineWhenReady(orgConfig) {
    const { slug } = orgConfig;

    // Nothing left to report for this org (the report succeeded, or the endpoint
    // 404'd) ⇒ never enter the gate. The reporter is a no-op from here on, and
    // waiting for readiness before a no-op would make every later reconnect
    // poll for minutes and log holds for work that no longer exists.
    if (isAlreadyReported(slug)) return;

    if (waiting.has(slug)) {
      // Not silent: otherwise a periodic tick that appears to do nothing looks
      // like a bug when read back from a log.
      log(`[readiness] [${slug}] online-report already waiting for agent readiness — skipping duplicate wait`);
      return;
    }
    waiting.add(slug);
    try {
      if (isDisabled()) {
        log(`[readiness] [${slug}] gate disabled by config — reporting online immediately`);
        await reportAgentOnline(orgConfig);
        return;
      }
      const verdict = await gate.waitUntilReady({
        onWait: ({ reason, detail, waitedMs, kind }) => {
          const prefix = kind === 'blocked'
            ? `[readiness] [${slug}] online-report HELD: ${reason}`
            : `[readiness] [${slug}] online-report still held: ${reason} (waited ${secs(waitedMs)})`;
          log(`${prefix} — ${formatReadinessDetail(detail)}`);
        },
      });
      if (verdict.timedOut) {
        // Cap reached. Report anyway — a delayed onboarding beats an org that
        // never onboards because its agent stayed busy.
        warn(`[readiness] [${slug}] agent STILL not ready after ${secs(verdict.waitedMs)} (${verdict.reason}) — reporting online anyway (fail-open cap reached) — ${formatReadinessDetail(verdict.detail)}`);
      } else if (verdict.waitedMs > 0) {
        log(`[readiness] [${slug}] agent READY after ${secs(verdict.waitedMs)} (${verdict.polls} polls) — reporting online — ${formatReadinessDetail(verdict.detail)}`);
      } else {
        log(`[readiness] [${slug}] agent ready on first check — reporting online without delay — ${formatReadinessDetail(verdict.detail)}`);
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
