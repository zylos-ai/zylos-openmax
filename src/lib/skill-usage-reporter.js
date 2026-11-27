/**
 * Skill-usage reporter (OPENM-1396, tech-plan-delta 11-27 §3.3): the
 * comm-bridge background task that turns registered Web DM turns into K3
 * reports (activity/skills-used.js has the per-turn state and rules,
 * skill-usage-contract.js the endpoint).
 *
 * Each tick, for every registration:
 *   - past SKILL_TURN_RETENTION_MS → removed (gives up, retries included);
 *   - the session log is read on from the stored offsets (bounded per tick)
 *     until the turn's turn_end;
 *   - decideReport: wait, drop (nothing to show), or report;
 *   - report → PUT to the conversation's org as the Agent itself.
 *
 * PUT outcomes, like channel-liveness (issue #72): a 404 means the route is
 * off or absent for that org — the org is paused for `reprobeMs` (warned once):
 * no PUT, and comm-bridge stops registering turns without a selection for it
 * (shouldRegister); after the pause the next report is the re-probe (turns with
 * a selection stay registered and are retried then). 503 / 5xx / 429 / network
 * → retried with exponential backoff while the registration is kept. Any other
 * 4xx → given up. Success → removed.
 *
 * Not gated on OPENMAX_ACTIVITY. Never throws into the task loop.
 */

import { putForOrg as realPutForOrg, apiPath as realApiPath } from './client.js';
import { REPORT_REQUEST_TIMEOUT_MS } from './metrics-reporter.js';
import {
  SKILLS_USED_DIR, SKILL_TURN_RETENTION_MS,
  listSkillTurns, readSkillTurn, writeSkillTurn, dropSkillTurn, readFirstReply, sweepOrphans,
  advanceScan, finalizeScan, decideReport,
} from './activity/skills-used.js';
import { skillUsagePath, skillUsageBody, classifySkillUsageError } from './skill-usage-contract.js';

export const SKILL_USAGE_TICK_MS = 5_000;
export const SKILL_USAGE_REPROBE_MS = 3 * 60 * 60 * 1000;
export const SKILL_USAGE_RETRY_BASE_MS = 30_000;
export const SKILL_USAGE_RETRY_MAX_MS = 30 * 60 * 1000;

export function createSkillUsageReporter({
  log, warn,
  putForOrg = realPutForOrg,
  apiPath = realApiPath,
  dir = SKILLS_USED_DIR,
  scanDeps = {},
  runStore,
  now = Date.now,
  reprobeMs = SKILL_USAGE_REPROBE_MS,
  retryBaseMs = SKILL_USAGE_RETRY_BASE_MS,
  retryMaxMs = SKILL_USAGE_RETRY_MAX_MS,
  requestTimeoutMs = REPORT_REQUEST_TIMEOUT_MS,
} = {}) {
  const paused = new Map(); // org_id → paused until (ms)

  const isPaused = (orgId, t = now()) => (paused.get(orgId) ?? 0) > t;

  /**
   * comm-bridge: whether to register a turn of this org. A turn with a
   * selection is always registered (its ③ fallback needs the report); one
   * without is skipped while the org's endpoint is paused after a 404.
   */
  function shouldRegister(orgId, hasSelection) {
    return hasSelection || !isPaused(orgId);
  }

  async function report(reg, decision, t) {
    const orgId = reg.org_id;
    try {
      await putForOrg(
        orgId,
        apiPath(skillUsagePath(reg.member_id)),
        skillUsageBody({
          sourceMessageId: reg.source_message_id,
          replyMessageId: decision.replyMessageId,
          complete: decision.complete,
          skillIds: decision.skillIds,
        }),
        { timeoutMs: requestTimeoutMs },
      );
      if (paused.has(orgId)) {
        paused.delete(orgId);
        log?.(`skill-usage: endpoint recovered for org ${orgId} — resuming`);
      }
      dropSkillTurn(reg.source_message_id, { dir });
      log?.(`skill-usage: reported msg=${reg.source_message_id} reply=${decision.replyMessageId} complete=${decision.complete} skills=${decision.skillIds.length}${decision.reasons.length ? ` (${decision.reasons.join(',')})` : ''}`);
    } catch (err) {
      const kind = classifySkillUsageError(err);
      if (kind === 'absent') {
        if (!paused.has(orgId)) {
          warn?.(`skill-usage: endpoint returns 404 for org ${orgId} (off or not deployed); pausing reports and no-selection registrations, re-probe in ${Math.round(reprobeMs / 60000)} min`);
        }
        paused.set(orgId, t + reprobeMs);
        reg.report.next_at = t + reprobeMs;
        writeSkillTurn(reg, { dir });
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
    for (const id of listSkillTurns({ dir })) {
      try {
        const reg = readSkillTurn(id, { dir });
        if (!reg || reg.v !== 2 || !reg.scan) { dropSkillTurn(id, { dir }); continue; }
        if (t - reg.registered_at > SKILL_TURN_RETENTION_MS) {
          dropSkillTurn(id, { dir });
          log?.(`skill-usage: msg=${id} expired unreported`);
          continue;
        }
        if (!reg.scan.ended_at) {
          const before = JSON.stringify(reg.scan);
          advanceScan(reg, { ...scanDeps, now: t });
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
        // eslint-disable-next-line no-await-in-loop
        await report(reg, decision, t);
      } catch (err) {
        warn?.(`skill-usage: msg=${id} tick error: ${err?.message || err}`);
      }
    }
  }

  return { tick, shouldRegister, isPaused };
}

/**
 * comm-bridge: whether an inbound message starts a turn whose skills are
 * reported — an OpenMax Web DM or a topic of one (PRD §2 / §6.5: not groups,
 * app sub-conversations or other kinds), sent by a human member (not an
 * Agent, not a System Member), answered in its own conversation (a card
 * receipt is redirected to the card's conversation and is not a Web turn).
 */
export function isSkillUsageTurn({ endpointType, redirected, senderMember, systemSender }) {
  return (endpointType === 'dm' || endpointType === 'dm-topic')
    && !redirected && !systemSender && senderMember?.kind === 'human';
}
