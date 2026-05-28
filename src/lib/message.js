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
 * Format a single recent-message line for context blocks: `[name]: content`.
 */
function formatContextLine(m) {
  const name = m.senderName || m.sender_display_name || m.sender_id || 'unknown';
  const text = m.content ?? m.content_text ?? '';
  return `[${name}]: ${text}`;
}

/**
 * Build the C4-bridge inbound text for a single incoming message.
 *
 * @param {object} conv - { type:'dm'|'group'|'thread', id?:string }
 * @param {object} sender - { displayName }
 * @param {object} current - { content:string, type?:'text'|'image'|'file',
 *                             mediaLocalPath?:string }
 * @param {Array}  [recent] - prior messages used for group/thread context
 * @returns {string}
 */
export function formatInboundForC4(conv, sender, current, recent = []) {
  const type = VALID_TYPES.has(conv.type) ? conv.type : 'dm';
  const tag = TYPE_TAG[type];
  const name = sender?.displayName || sender?.display_name || sender?.id || 'unknown';
  const content = current?.content ?? '';

  let body;
  if (type === 'dm') {
    body = content;
  } else {
    const ctxLabel = type === 'thread'
      ? '[Thread context:]'
      : '[Group context - recent messages:]';
    const ctxLines = (recent || []).map(formatContextLine).join('\n');
    body = ctxLines
      ? `${ctxLabel}\n${ctxLines}\n\n[Current message:] ${content}`
      : `[Current message:] ${content}`;
  }

  let line = `${tag} ${name} said: ${body}`;
  if (current?.mediaLocalPath) {
    const kind = current.type === 'image' ? 'image' : 'file';
    line += ` ---- ${kind}: ${current.mediaLocalPath}`;
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

