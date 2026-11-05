/**
 * Quoted excerpt (OPENM-945, phase 1).
 *
 * When a user quotes part of a message, the web FE sends `parent_id` plus
 * message metadata
 *
 *   quote_excerpts: { version: 1, items: [{ message_id, text, offset?, truncated? }] }
 *
 * and when the quoted original is recalled, cws-comm rewrites the item into a
 * tombstone `{ message_id, recalled: true }`. `metadata` is an opaque
 * pass-through any client can write, so it is read with the same lenient
 * rules as the FE's `readQuoteExcerpt`: anything unexpected means "no excerpt"
 * and the inbound text stays exactly as for a plain reply.
 */

export const MAX_EXCERPT_CODE_POINTS = 1000;

/**
 * @returns {null | { kind: 'recalled' } | { kind: 'excerpt', text: string }}
 */
export function quoteExcerptFrom(msg, parentId) {
  if (!msg || typeof msg !== 'object' || parentId === undefined || parentId === null) return null;
  const meta = [msg.metadata, msg.message?.metadata]
    .find((m) => m && typeof m === 'object' && !Array.isArray(m) && 'quote_excerpts' in m);
  const qe = meta?.quote_excerpts;
  if (!qe || typeof qe !== 'object' || Array.isArray(qe)) return null;
  if (qe.version !== 1 || !Array.isArray(qe.items)) return null;

  // Phase 1 sends exactly one item; later items are a phase-2 extension.
  const item = qe.items[0];
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  if (typeof item.message_id !== 'string' || item.message_id !== String(parentId)) return null;
  // A tombstone may still carry a stale `text`; it must never be shown.
  if (item.recalled === true) return { kind: 'recalled' };
  if (typeof item.text !== 'string' || !item.text.trim()) return null;

  const chars = [...item.text];
  const text = chars.length > MAX_EXCERPT_CODE_POINTS
    ? chars.slice(0, MAX_EXCERPT_CODE_POINTS).join('')
    : item.text;
  return { kind: 'excerpt', text };
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/[\r\n\u2028\u2029]+/g, ' ');
}

// The FE selects rendered text, so markdown syntax is reduced to what a reader
// sees before comparing. Applied to both sides: syntax added to a tampered
// excerpt is stripped too, and what remains must still be in the original.
function comparable(s) {
  return String(s)
    .replace(/^[ \t]*(?:```|~~~).*$/gm, '')            // code fences
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '')               // headings
    .replace(/^[ \t]*>[ \t]?/gm, '')                    // blockquotes
    .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, '')     // list markers
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')           // links / images → text
    .replace(/[*_`~]/g, '')                             // emphasis / inline code
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Render the <quoted-excerpt> element, or '' when there is no usable excerpt
 * (a tombstone renders nothing: the quoted text was recalled).
 *
 * The excerpt comes from the quoting client, not from the quoted message, yet
 * `from` names the quoted author; `unverified="true"` marks an excerpt not
 * found in `parentText` so it cannot pass as that author's words.
 */
export function formatQuotedExcerpt(sender, excerpt, parentText) {
  if (excerpt?.kind !== 'excerpt') return '';
  const needle = comparable(excerpt.text);
  const verified = needle !== '' && comparable(parentText ?? '').includes(needle);
  const unverified = verified ? '' : ' unverified="true"';
  return `<quoted-excerpt from="${escapeAttr(sender || 'unknown')}"${unverified}>\n${escapeText(excerpt.text)}\n</quoted-excerpt>`;
}
