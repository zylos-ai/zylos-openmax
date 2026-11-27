/**
 * The cws-core K3 contract for "skills used this turn" (OPENM-1396,
 * tech-plan-delta 11-27 §3.2 MR-K3). Everything the plugin assumes about the
 * endpoint is here, so it can be adjusted in one place when K3 lands.
 *
 *   PUT /api/v1/agents/{member_id}/skill-usage        (Agent JWT, self-report)
 *   { source_message_id, reply_message_id, complete, skill_ids }
 *
 *   - member_id: the Agent's own member id in the org of the conversation
 *     (cws-core authorizeAgentSelfReport: the caller must be that Agent);
 *   - source_message_id: the user's message that started the turn;
 *   - reply_message_id: the turn's first Web reply, sent by this Agent (K3
 *     checks sender and that the conversation is a human ↔ Agent DM or a topic
 *     of one); one record per reply, upserted;
 *   - complete: true only when the turn's turn_end was seen and the list is
 *     provably whole; false → skill_ids is always [];
 *   - skill_ids: every skill the turn called, first-use order, deduplicated,
 *     at most 50 (market skill_id, or `local:<dir>`); system skills included —
 *     K3 filters by the Agent's catalog and stores the names of the time.
 *
 * Answers the reporter relies on:
 *   2xx                → stored (or nothing to store); the registration is removed;
 *   404                → feature off (CONVERSATION_SKILLS_ENABLED) or route not
 *                        deployed: back off for the org, re-probe later;
 *   503, 5xx, 429,     → retry with backoff while the registration is kept;
 *   network, timeout
 *   other 4xx          → give up (logged).
 */

export const SKILL_USAGE_METHOD = 'PUT';

/** Path under /api/v1 (pass through client.js apiPath). */
export function skillUsagePath(memberId) {
  return `/agents/${encodeURIComponent(memberId)}/skill-usage`;
}

export function skillUsageBody({ sourceMessageId, replyMessageId, complete, skillIds }) {
  return {
    source_message_id: String(sourceMessageId),
    reply_message_id: String(replyMessageId),
    complete: complete === true,
    skill_ids: complete === true ? [...skillIds] : [],
  };
}

/** How the reporter treats an error from the PUT. */
export function classifySkillUsageError(err) {
  const s = err?.status;
  if (s === 404) return 'absent';
  if (s == null || s === 429 || s >= 500) return 'retry';
  return 'give_up';
}
