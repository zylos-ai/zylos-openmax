/**
 * Message format helpers per DESIGN.md §3.4 and §3.5.
 *
 * Endpoint format (C4 routing key / `reply via` target):
 *   <conversationId>
 *   <conversationId>|reply:<messageId>
 *   <conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * The conversation type ([COCO DM]/[COCO GROUP]/[COCO THREAD]) is NOT part of
 * the target: send.js routes purely off the conversation id plus the
 * reply/thread/parent suffixes, so the type prefix was dead weight in the
 * `reply via` string the agent has to copy. `parseEndpoint` still accepts the
 * legacy `[COCO TYPE]/<id>...` form for backward compatibility (in-flight
 * messages, older callers), but `formatEndpoint` now emits the minimal form.
 *
 * Inbound C4 text format (tag on its own line; the attributed utterance lives
 * inside <current-message> for parity with other C4 channels):
 *   [COCO DM]
 *   <current-message>
 *   <name> said: <content>
 *   </current-message>
 *
 *   [COCO GROUP:<group>]
 *   <group-context>...</group-context>
 *   <current-message>
 *   <name> said: <content>
 *   </current-message>
 *   (with optional `---- file: <path>` or `---- image: <path>` suffix)
 */

import { randomUUID } from 'crypto';

const TYPE_TAG = { dm: '[COCO DM]', group: '[COCO GROUP]', thread: '[COCO THREAD]' };
const VALID_TYPES = new Set(['dm', 'group', 'thread']);

// Forced skill-flow directive, appended INSIDE the <current-message> block right
// after the user's words when `enforceSkillFlow` is on
// (config.message.enforceSkillFlow, default true). Placed post-user-content
// (not as a leading namespace-style tag) on purpose: recency + co-location with
// the actual ask maximize the chance the agent acts on it, whereas a leading
// `<coco-workspace>` envelope tends to be read as ignorable metadata and skipped.
// The rule travels with the component: upgrade coco-workspace → every inbound
// human task is forced through the skill flow, with no per-bot instruction edits.
const SKILL_FLOW_DIRECTIVE =
`[SYSTEM · DO FIRST] If the above is a task from a human (do-it-for-me / review / analyze / develop / integrate / research — anything that produces a deliverable): you MUST follow the coco-workspace skill — classify it as simple vs complex, register Issue→Task, and run the matching flow (simple = light; complex = heavy mode + Blueprint approval) before acting. Do NOT answer it as casual chat. Only pure Q&A / chit-chat may be answered directly. The skill is the source of truth.`;

/**
 * Generate a client-side idempotency key for SendMessageRequest.client_msg_id.
 * The server de-dupes identical client_msg_id within 5 minutes (api-design.md §5.1).
 */
export function newClientMsgId() {
  return `c_${randomUUID()}`;
}

/**
 * Parse a C4 endpoint string into structured fields.
 *
 * Accepts two forms:
 *   - minimal (current):  `<conversationId>[|reply:..][|thread:..][|parent:..]`
 *   - legacy:             `[COCO TYPE]/<conversationId>[|...]`  (prefix stripped)
 *
 * The leading conversation id is whatever precedes the first `|`. The type
 * prefix, if present, is informational only — routing is driven entirely by
 * the conversation id and the reply/thread/parent suffixes.
 *
 * @param {string} endpoint
 * @returns {{type:string, conversationId:string, replyTo?:string,
 *            threadConversationId?:string, parentMessageId?:string}}
 */
export function parseEndpoint(endpoint) {
  let rest = (endpoint || '').trim();

  // Strip the legacy `[COCO TYPE]/` prefix if present (back-compat).
  let typeHint = null;
  const legacy = /^\[COCO (DM|GROUP|THREAD)\]\/(.*)$/.exec(rest);
  if (legacy) { typeHint = legacy[1].toLowerCase(); rest = legacy[2]; }

  const segments = rest.split('|');
  const conversationId = (segments.shift() || '').trim();
  if (!conversationId) throw new Error(`invalid endpoint: ${endpoint}`);

  const result = { conversationId };
  for (const part of segments.filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'reply')  result.replyTo = v;
    else if (k === 'thread') result.threadConversationId = v;
    else if (k === 'parent') result.parentMessageId = v;
  }
  // `type` is retained for callers that inspect it, but is not used for
  // routing. Prefer the legacy hint; otherwise infer from the suffixes.
  result.type = typeHint || (result.threadConversationId ? 'thread' : 'dm');
  return result;
}

/**
 * Build a C4 endpoint string (the `reply via` target) from structured fields.
 *
 * Emits the minimal form — conversation id plus reply/thread/parent suffixes.
 * The conversation type is intentionally omitted (see parseEndpoint): it was
 * never consulted by the send path. `ep.type` is accepted but ignored.
 *
 * @param {{type?:string, conversationId:string, replyTo?:string,
 *          threadConversationId?:string, parentMessageId?:string}} ep
 */
export function formatEndpoint(ep) {
  if (!ep?.conversationId) throw new Error('formatEndpoint: conversationId required');
  let s = `${ep.conversationId}`;
  if (ep.replyTo)              s += `|reply:${ep.replyTo}`;
  if (ep.threadConversationId) s += `|thread:${ep.threadConversationId}`;
  if (ep.parentMessageId)      s += `|parent:${ep.parentMessageId}`;
  return s;
}

/**
 * Neutralize the structural-breakout vector in user-supplied strings before
 * embedding them in the XML-tagged context blocks emitted by formatInboundForC4.
 *
 * The consumer is an LLM reading raw text, NOT an XML parser. The only real
 * threat is a sender planting a literal `</current-message>` (or any other
 * closing tag) to break out of the framing the model relies on — that requires
 * the `<` / `>` characters, so those are all we neutralize.
 *
 * We deliberately do NOT escape `&`, `"`, `'`: turning a user's natural
 * ampersands, quotes, and apostrophes into `&amp;` / `&quot;` / `&apos;` only
 * litters the text the model reads (e.g. `she said "hi"` → `she said &quot;hi&quot;`)
 * without preventing any breakout. Keeping prose verbatim gives the model a
 * cleaner, more faithful view of what the user actually wrote.
 */
function escapeXml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Format a single context-line entry: `[name]: text`. Both fields go through
 * escapeXml. Accepts the shape returned by fetchRecentMessages
 * ({senderName, content}) as well as generic {user_name|sender_id, text|content}.
 */
function formatContextLine(m) {
  const name = escapeXml(
       m.senderName
    || m.sender_display_name
    || m.user_name
    || m.sender_id
    || 'unknown',
  );
  const text = escapeXml(m.content ?? m.text ?? m.content_text ?? '');
  return `[${name}]: ${text}`;
}

/**
 * Build the C4-bridge inbound text for a single incoming message.
 *
 * Output framing mirrors zylos-feishu `src/index.js formatMessage`:
 *   - tag includes the group name for group / thread messages
 *     (`[COCO GROUP:Engineering]`)
 *   - context blocks are XML-tagged so the LLM can cleanly separate history
 *     from the current message
 *   - thread context, replying-to, and smart-mode hint blocks are emitted
 *     when the relevant opts are present
 *   - all user-supplied strings go through escapeXml
 *
 * @param {object} conv     - { type:'dm'|'group'|'thread', id?, name? }
 * @param {object} sender   - { displayName }
 * @param {object} current  - { content:string, type?:'text'|'image'|'file',
 *                              mediaLocalPath?:string }
 * @param {Array}  [recent] - recent group messages used for `<group-context>`
 * @param {object} [opts]   - { groupName, quotedContent, threadContext,
 *                              threadRootId, smartHint }
 * @returns {string}
 */
export function formatInboundForC4(conv, sender, current, recent = [], opts = {}) {
  const rawType = (conv?.type || '').toLowerCase();
  const type = VALID_TYPES.has(rawType) ? rawType : 'dm';
  const { groupName, quotedContent, threadContext, threadRootId, smartHint, enforceSkillFlow } = opts;

  const name = sender?.displayName || sender?.display_name || sender?.id || 'unknown';
  const safeName = escapeXml(name);
  const safeContent = escapeXml(current?.content ?? '');

  const baseTag = TYPE_TAG[type];
  // baseTag is like "[COCO GROUP]" — inject ":<name>" before the closing "]".
  const tag = (type === 'group' || type === 'thread')
    ? `${baseTag.slice(0, -1)}:${escapeXml(groupName || conv?.name || 'unknown')}]`
    : baseTag;

  // Tag on its own line; the `<name> said: ...` attribution now lives inside
  // the <current-message> block (semantic parity with other C4 channels).
  const parts = [`${tag}\n`];

  if (threadContext && threadContext.length > 0) {
    const lines = threadContext.map(m => {
      const line = formatContextLine(m);
      const id = m.message_id || m.id;
      if (threadRootId && id && String(id) === String(threadRootId)) {
        return `<thread-root>\n${line}\n</thread-root>`;
      }
      return line;
    });
    parts.push(`<thread-context>\n${lines.join('\n')}\n</thread-context>\n\n`);
  } else if (type !== 'dm' && recent && recent.length > 0) {
    const lines = recent.map(formatContextLine);
    parts.push(`<group-context>\n${lines.join('\n')}\n</group-context>\n\n`);
  }

  if (quotedContent && !(threadContext && threadContext.length > 0)) {
    const qsender = escapeXml(quotedContent.sender || quotedContent.senderName || 'unknown');
    const qtext   = escapeXml(quotedContent.text   || quotedContent.content    || '');
    parts.push(`<replying-to>\n[${qsender}]: ${qtext}\n</replying-to>\n\n`);
  }

  if (smartHint) {
    parts.push(
`<smart-mode>
Decide whether to respond. Do NOT reply if: the message is unrelated to you,
just casual chat, or doesn't need your input. Only reply when:
1) someone asks a question you can help with,
2) discussing technical topics you know well,
3) someone clearly needs assistance.
When uncertain, prefer NOT to reply. Reply with exactly [SKIP] to stay silent.
</smart-mode>\n\n`,
    );
  }

  // Append the skill-flow directive INSIDE current-message, right after the
  // user's words (recency + can't be dismissed as envelope). enforceSkillFlow gates it.
  const directiveSuffix = enforceSkillFlow ? `\n\n${SKILL_FLOW_DIRECTIVE}` : '';
  parts.push(`<current-message>\n${safeName} said: ${safeContent}${directiveSuffix}\n</current-message>`);

  let line = parts.join('');
  if (current?.mediaLocalPath) {
    const kind = current.type === 'image' ? 'image' : 'file';
    line += ` ---- ${kind}: ${escapeXml(current.mediaLocalPath)}`;
  }
  return line;
}

/**
 * Heuristic markdown auto-detection for outbound messages.
 * Matches presence of headings, emphasis, code fences, lists, or links.
 */
export function looksLikeMarkdown(text) {
  if (typeof text !== 'string' || !text) return false;
  return /(^|\n)(#{1,6}\s|[*_-]{1,3}\s|```|\|\s|>\s|\d+\.\s)/.test(text) ||
         /\[[^\]]+\]\([^)]+\)/.test(text) ||
         /\*\*\S/.test(text) ||
         /`[^`]+`/.test(text);
}

/**
 * MEDIA prefix detection for outbound messages.
 * Matches `[MEDIA:image]/path/to/file` or `[MEDIA:file]/path/to/doc.pdf`.
 */
export function parseMediaPrefix(message) {
  const m = /^\[MEDIA:(image|file)\](.+)$/s.exec(message || '');
  if (!m) return null;
  return { kind: m[1], localPath: m[2].trim() };
}

/**
 * Split a long message into chunks that fit within maxLen characters.
 * Tries to break at paragraph (double-newline) boundaries first, then
 * single-newline boundaries, then hard-cuts as a last resort.
 */
export function splitMessage(text, maxLen = 3000) {
  if (!text || text.length <= maxLen) return [text];

  const chunks = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let cut = -1;

    // prefer paragraph break
    cut = remaining.lastIndexOf('\n\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut).trimStart(); continue; }

    // fallback: single newline
    cut = remaining.lastIndexOf('\n', maxLen);
    if (cut > maxLen * 0.4) { chunks.push(remaining.slice(0, cut).trimEnd()); remaining = remaining.slice(cut + 1).trimStart(); continue; }

    // last resort: hard cut at maxLen
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

