/**
 * Message format helpers per DESIGN.md §3.4 and §3.5.
 *
 * Endpoint format (C4 routing key):
 *   [COCO DM]/<conversationId>
 *   [COCO GROUP]/<conversationId>|reply:<messageId>
 *   [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * Inbound C4 text format:
 *   [COCO DM]    <name> said: <content>
 *   [COCO GROUP] <name> said: [Group context - recent messages:]\n<ctx>\n\n[Current message:] <content>
 *   [COCO THREAD]<name> said: [Thread context:]\n<ctx>\n\n[Current message:] <content>
 *   (with optional `---- file: <path>` or `---- image: <path>` suffix)
 */

import { randomUUID } from 'crypto';

const TYPE_TAG = { dm: '[COCO DM]', group: '[COCO GROUP]', thread: '[COCO THREAD]' };
const VALID_TYPES = new Set(['dm', 'group', 'thread']);

/**
 * Generate a client-side idempotency key for SendMessageRequest.client_msg_id.
 * The server de-dupes identical client_msg_id within 5 minutes (api-design.md §5.1).
 */
export function newClientMsgId() {
  return `c_${randomUUID()}`;
}

/**
 * Parse a C4 endpoint string into structured fields.
 * @param {string} endpoint
 * @returns {{type:string, conversationId:string, replyTo?:string,
 *            threadConversationId?:string, parentMessageId?:string}}
 */
export function parseEndpoint(endpoint) {
  const m = /^\[COCO (DM|GROUP|THREAD)\]\/([^|]+)(.*)$/.exec(endpoint || '');
  if (!m) throw new Error(`invalid endpoint: ${endpoint}`);

  const result = { type: m[1].toLowerCase(), conversationId: m[2] };
  for (const part of (m[3] || '').split('|').filter(Boolean)) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    const k = part.slice(0, idx);
    const v = part.slice(idx + 1);
    if (k === 'reply')  result.replyTo = v;
    else if (k === 'thread') result.threadConversationId = v;
    else if (k === 'parent') result.parentMessageId = v;
  }
  return result;
}

/**
 * Build a C4 endpoint string from structured fields.
 * @param {{type:string, conversationId:string, replyTo?:string,
 *          threadConversationId?:string, parentMessageId?:string}} ep
 */
export function formatEndpoint(ep) {
  const tag = TYPE_TAG[ep.type];
  if (!tag) throw new Error(`unknown conversation type: ${ep.type}`);
  let s = `${tag}/${ep.conversationId}`;
  if (ep.replyTo)              s += `|reply:${ep.replyTo}`;
  if (ep.threadConversationId) s += `|thread:${ep.threadConversationId}`;
  if (ep.parentMessageId)      s += `|parent:${ep.parentMessageId}`;
  return s;
}

/**
 * Escape XML special chars in user-supplied strings before embedding them in
 * the XML-tagged context blocks emitted by formatInboundForC4. Without this a
 * sender could plant a literal `</current-message>` in their text and break
 * out of the structural framing the LLM relies on.
 */
function escapeXml(s) {
  if (s === undefined || s === null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
  const { groupName, quotedContent, threadContext, threadRootId, smartHint } = opts;

  const name = sender?.displayName || sender?.display_name || sender?.id || 'unknown';
  const safeName = escapeXml(name);
  const safeContent = escapeXml(current?.content ?? '');

  const baseTag = TYPE_TAG[type];
  // baseTag is like "[COCO GROUP]" — inject ":<name>" before the closing "]".
  const tag = (type === 'group' || type === 'thread')
    ? `${baseTag.slice(0, -1)}:${escapeXml(groupName || conv?.name || 'unknown')}]`
    : baseTag;

  const parts = [`${tag} ${safeName} said: `];

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

  parts.push(`<current-message>\n${safeContent}\n</current-message>`);

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

