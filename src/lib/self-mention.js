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
