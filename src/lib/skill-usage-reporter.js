/**
 * Skill-usage reporter (OPENM-1396, tech-plan-delta 11-27 §3.3): the
 * comm-bridge background task that turns registered Web DM turns into K3
 * reports (activity/skills-used.js has the per-turn state and rules,
 * skill-usage-contract.js the endpoint).
 *
 * Each tick, for every registration:
 *   - past SKILL_TURN_RETENTION_MS → removed (gives up, retries included);
 *   - the session log is read on from the stored offsets until the turn's
 *     turn_end — bounded per registration (SCAN_BYTES_PER_TICK) and for all
 *     registrations together (SCAN_BYTES_PER_TICK_TOTAL); the registration
 *     the tick starts with rotates, so none waits behind the others;
 *   - decideReport: wait, drop (nothing to show), or report;
 *   - report → PUT to the conversation's org as the Agent itself.
 *
 * PUT outcomes (skill-usage-contract.js): a 404 whose body carries
 * `SKILL_USAGE_DISABLED` means the feature is off for that org — the org is
 * paused for `reprobeMs` (warned once): no PUT, and comm-bridge stops
 * registering turns without a selection for it (shouldRegister). The record
 * that got it is dropped, so no single record keeps the org paused; after the
 * pause the next real report is the probe. Any other 404 (route missing: a
 * server without K3) gives up that record and backs the org's PUTs off for
 * `routeBackoffMs` (warned once per window; registration goes on, records
 * wait), so such a server is not hit — and warned about — on every turn. Any
 * other 4xx gives up that record only (409 SKILL_USAGE_SOURCE_ALREADY_REPORTED
 * included). A 401 (client.js's own refresh-and-retry did not cure it, or was
 * throttled) → the org's token is re-minted (reacquireToken force) and the
 * PUT is sent once more; a second 401 gives up that record. 503 / 5xx / 429 /
 * network → retried with exponential backoff while the registration is kept.
 * Success → removed.
 *
 * Not gated on OPENMAX_ACTIVITY. Never throws into the task loop.
 */

import { putForOrg as realPutForOrg, apiPath as realApiPath, reacquireToken as realReacquireToken } from './client.js';
import { REPORT_REQUEST_TIMEOUT_MS } from './metrics-reporter.js';
import {
  SKILLS_USED_DIR, SKILL_TURN_RETENTION_MS, SCAN_BYTES_PER_TICK, SCAN_BYTES_PER_TICK_TOTAL,
  listSkillTurns, readSkillTurn, writeSkillTurn, dropSkillTurn, readFirstReply, sweepOrphans,
  advanceScan, finalizeScan, decideReport,
} from './activity/skills-used.js';
import { skillUsagePath, skillUsageBody, classifySkillUsageError } from './skill-usage-contract.js';
import { skillPreferenceApplies } from './skill-preference.js';

export const SKILL_USAGE_TICK_MS = 5_000;
export const SKILL_USAGE_REPROBE_MS = 3 * 60 * 60 * 1000;
/** No PUT for an org this long after a 404 that is not SKILL_USAGE_DISABLED. */
export const SKILL_USAGE_ROUTE_BACKOFF_MS = 60 * 60 * 1000;
export const SKILL_USAGE_RETRY_BASE_MS = 30_000;
export const SKILL_USAGE_RETRY_MAX_MS = 30 * 60 * 1000;

export function createSkillUsageReporter({
  log, warn,
  putForOrg = realPutForOrg,
  apiPath = realApiPath,
  reacquireToken = realReacquireToken,
  dir = SKILLS_USED_DIR,
  scanDeps = {},
  runStore,
  now = Date.now,
  reprobeMs = SKILL_USAGE_REPROBE_MS,
  routeBackoffMs = SKILL_USAGE_ROUTE_BACKOFF_MS,
  retryBaseMs = SKILL_USAGE_RETRY_BASE_MS,
  retryMaxMs = SKILL_USAGE_RETRY_MAX_MS,
  requestTimeoutMs = REPORT_REQUEST_TIMEOUT_MS,
  scanBytesPerTick = SCAN_BYTES_PER_TICK,
  scanBytesPerTickTotal = SCAN_BYTES_PER_TICK_TOTAL,
} = {}) {
  const paused = new Map(); // org_id → paused until (ms)
  const routeBackoff = new Map(); // org_id → no PUT until (ms), after an unknown 404
  let rotation = 0; // where the next tick starts in the registration list

  const isPaused = (orgId, t = now()) => (paused.get(orgId) ?? 0) > t;

  /**
   * comm-bridge: whether to register a turn of this org. A turn with a
   * selection is always registered (its ③ fallback needs the report); one
   * without is skipped while the org is paused after a feature-off 404.
   */
  function shouldRegister(orgId, hasSelection) {
    return hasSelection || !isPaused(orgId);
  }

  async function report(reg, decision, t) {
    const orgId = reg.org_id;
    const put = () => putForOrg(
      orgId,
      apiPath(skillUsagePath(reg.member_id)),
      skillUsageBody({
        sourceMessageId: reg.source_message_id,
        replyMessageId: decision.replyMessageId,
        complete: decision.complete,
        skillIds: decision.skillIds,
      }),
      { timeoutMs: requestTimeoutMs, quietOnSuccess: true },
    );
    try {
      try {
        await put();
      } catch (err) {
        if (err?.status !== 401) throw err;
        // A 401 client.js did not cure (its one refresh is throttled per org):
        // mint a fresh token and send once more; a second 401 is given up.
        warn?.(`skill-usage: report msg=${reg.source_message_id} got 401; re-acquiring the token and retrying once`);
        await reacquireToken(orgId, { force: true });
        await put();
      }
      routeBackoff.delete(orgId);
      if (paused.has(orgId)) {
        paused.delete(orgId);
        log?.(`skill-usage: endpoint recovered for org ${orgId} — resuming`);
      }
      dropSkillTurn(reg.source_message_id, { dir });
      log?.(`skill-usage: reported msg=${reg.source_message_id} reply=${decision.replyMessageId} complete=${decision.complete} skills=${decision.skillIds.length}${decision.reasons.length ? ` (${decision.reasons.join(',')})` : ''}`);
    } catch (err) {
      const kind = classifySkillUsageError(err);
      if (kind === 'disabled') {
        if (!paused.has(orgId)) {
          warn?.(`skill-usage: feature off for org ${orgId} (404 SKILL_USAGE_DISABLED); pausing reports and no-selection registrations, re-probe in ${Math.round(reprobeMs / 60000)} min`);
        }
        paused.set(orgId, t + reprobeMs);
        dropSkillTurn(reg.source_message_id, { dir });
      } else if (kind === 'route_missing') {
        // No PUT of this org reaches here inside the window, so this warns
        // at most once per window.
        dropSkillTurn(reg.source_message_id, { dir });
        routeBackoff.set(orgId, t + routeBackoffMs);
        warn?.(`skill-usage: report msg=${reg.source_message_id} got 404 (${err?.body?.error?.code || 'no SKILL_USAGE_DISABLED code'}): endpoint missing for org ${orgId}? giving the record up; no reports for ${Math.round(routeBackoffMs / 60000)} min`);
      } else if (kind === 'retry') {
        reg.report.attempts += 1;
        reg.report.next_at = t + Math.min(retryMaxMs, retryBaseMs * 2 ** (reg.report.attempts - 1));
        writeSkillTurn(reg, { dir });
        warn?.(`skill-usage: report msg=${reg.source_message_id} failed (${err?.status || err?.message || err}); retry #${reg.report.attempts}`);
      } else {
        dropSkillTurn(reg.source_message_id, { dir });
        warn?.(`skill-usage: report msg=${reg.source_message_id} rejected (${err?.status}: ${err?.message || ''}); giving up`);
      }
    }
  }

  async function tick() {
    const t = now();
    sweepOrphans({ dir, now: t });
    const ids = listSkillTurns({ dir }).sort();
    // Rotate the start so a busy registration cannot starve the ones after it.
    const start = ids.length ? rotation % ids.length : 0;
    rotation = start + 1;
    let scanLeft = scanBytesPerTickTotal;
    for (const id of [...ids.slice(start), ...ids.slice(0, start)]) {
      try {
        const reg = readSkillTurn(id, { dir });
        if (!reg || reg.v !== 2 || !reg.scan) { dropSkillTurn(id, { dir }); continue; }
        if (t - reg.registered_at > SKILL_TURN_RETENTION_MS) {
          dropSkillTurn(id, { dir });
          log?.(`skill-usage: msg=${id} expired unreported`);
          continue;
        }
        if (!reg.scan.ended_at && scanLeft > 0) {
          const before = JSON.stringify(reg.scan);
          const { bytes } = advanceScan(reg, { ...scanDeps, budget: Math.min(scanBytesPerTick, scanLeft), now: t });
          scanLeft -= bytes;
          if (JSON.stringify(reg.scan) !== before) writeSkillTurn(reg, { dir });
        }
        const outcome = reg.scan.ended_at
          ? finalizeScan(reg, runStore ? { runStore } : {})
          : { complete: false, skillIds: [], reasons: reg.scan.reasons };
        const decision = decideReport({ reg, outcome, replyMessageId: readFirstReply(id, { dir }), now: t });
        if (decision.action === 'wait') continue;
        if (decision.action === 'drop') {
          dropSkillTurn(id, { dir });
          log?.(`skill-usage: msg=${id} not reported (${decision.why})`);
          continue;
        }
        if (reg.report.next_at > t) continue;
        if (isPaused(reg.org_id, t)) continue;
        if ((routeBackoff.get(reg.org_id) ?? 0) > t) continue;
        // eslint-disable-next-line no-await-in-loop
        await report(reg, decision, t);
      } catch (err) {
        warn?.(`skill-usage: msg=${id} tick error: ${err?.message || err}`);
      }
    }
  }

  const isBackedOff = (orgId, t = now()) => (routeBackoff.get(orgId) ?? 0) > t;

  return { tick, shouldRegister, isPaused, isBackedOff };
}

/**
 * comm-bridge: whether an inbound message starts a turn whose skills are
 * reported — an OpenMax Web DM or a topic of one (PRD §2 / §6.5: not groups,
 * app sub-conversations or other kinds), sent by a human member (not an
 * Agent, not a System Member), answered in its own conversation (a card
 * receipt is redirected to the card's conversation and is not a Web turn).
 */
export function isSkillUsageTurn({ endpointType, redirected, senderMember, systemSender }) {
  return !redirected && skillPreferenceApplies({ endpointType, senderMember, systemSender });
}

/**
 * comm-bridge, after the forward (c4-receive.js forwardToC4): whether the
 * outcome proves Core never stored the inbound, so its turn will never run
 * and the registration is dropped. 'uncertain' / 'unknown' / 'failed' may
 * have been delivered: the registration is kept (a turn that never ran ends
 * unreported after TURN_END_WAIT_MS) — except a 'failed' whose c4-receive
 * never started at all (`neverStarted`, forwardToC4): nothing was stored.
 */
export function forwardDropsSkillTurn(outcome, { neverStarted = false } = {}) {
  return outcome === 'not_stored' || outcome === 'no_group' || (outcome === 'failed' && neverStarted === true);
}

/**
 * comm-bridge: the full session group (`namespace:name`) a forwarded turn
 * went to — Core's own answer when c4-receive printed one (`--json`
 * `sessionGroup`), else `<channel>:<the group name passed to Core>`. Null on a
 * single-session Core (no group).
 */
export function skillTurnSessionGroup(result, channel) {
  try {
    const out = result?.stdout ? JSON.parse(String(result.stdout).trim()) : null;
    if (typeof out?.sessionGroup === 'string' && out.sessionGroup) return out.sessionGroup;
  } catch {}
  const name = result?.sessionGroup;
  return typeof name === 'string' && name ? `${channel}:${name}` : null;
}
