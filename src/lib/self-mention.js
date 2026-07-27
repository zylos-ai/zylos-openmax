/**
 * Text-based self-mention detection for group messages.
 *
 * Extracted from comm-bridge.js so the @-boundary logic is unit-testable
 * (issue #85). cws-core's get-message returns raw text with a literal "@Name"
 * rather than a structured mentions[] array, so without this fallback the
 * `mode=mention` gate and the owner-mention bypass would never trigger in
 * practice.
 */

/**
 * Detect `@<selfName>` in a message's text body.
 *
 * @param {object} msg   cws-comm / cws-core message shape (several are tolerated).
 * @param {string} selfName  the agent's display name / handle to look for.
 * @returns {boolean} true if the text @-mentions exactly this name.
 */
export function isSelfNameMentionedInText(msg, selfName) {
  if (!selfName) return false;
  const text =
       msg.content?.body?.text
    || (typeof msg.content === 'string' ? msg.content : '')
    || (typeof msg.message?.content === 'string' ? msg.message.content : '')
    || msg.content_text
    || '';
  if (!text) return false;
  const escaped = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The negative lookahead prevents a short name from matching a longer one:
  //   - `[\w-]`   keeps "@Zylos" from matching "@Zylos-GavinBox" or "@ZylosX"
  //               (word chars + hyphen-separated handles).
  //   - `\.[\w]`  keeps "@luna" from matching a DOT-separated longer handle
  //               like "@luna.coco". Org handles are commonly dot-separated
  //               (luna.coco, Eric.He, howard.zhou), so without this a bare
  //               "luna" agent is falsely woken by "@luna.coco" — fleet-wide,
  //               and it also mis-fires the `senderIsOwner && mentioned`
  //               allowlist bypass. A dot NOT followed by a word char (e.g. a
  //               sentence-final "谢谢 @luna.") is still a genuine mention. (#85)
  return new RegExp('@' + escaped + '(?![\\w-]|\\.[\\w])', 'i').test(text);
}

/**
 * Decide whether THIS agent is @-mentioned in a message.
 *
 * Structured mention IDs are AUTHORITATIVE. cws-comm/cws-core treat the
 * message's `mentions[]` array (member UUIDs, `mentioned_id` per entry) as the
 * only real mention source and do NOT parse @names from the message text
 * (cws-core message.go: "cws-comm does not parse @names from the message text;
 * this array is the only mention source"). So:
 *
 *   1. If a structured mention matches our own member_id → mentioned.
 *   2. If structured mentions are present but none is us → NOT mentioned.
 *      (This is what fixes #85 / cws-comm #329: "@luna.coco" carries
 *      luna.coco's member_id, so a bare "luna" agent is not woken — and we
 *      never fall through to fragile text matching that would mis-fire.)
 *   3. Only if the payload carries NO structured mentions at all do we fall
 *      back to text matching (legacy/edge payloads), with a strict @-boundary.
 *
 * @param {object}   args
 * @param {string[]} args.mentionIds   structured mention member IDs from the message
 * @param {string}   args.selfMemberId this agent's member_id in the org
 * @param {string[]} args.selfNames    display_name + configured name aliases (text fallback)
 * @param {object}   args.msg          the message (for the text fallback)
 * @returns {boolean}
 */
export function isSelfMentioned({ mentionIds = [], selfMemberId, selfNames = [], msg } = {}) {
  const ids = (mentionIds || []).map(String);
  if (selfMemberId && ids.includes(String(selfMemberId))) return true; // (1) authoritative
  if (ids.length > 0) return false;                                    // (2) structured, not us
  return (selfNames || []).some((n) => isSelfNameMentionedInText(msg, n)); // (3) text fallback
}
