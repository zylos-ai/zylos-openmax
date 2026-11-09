/**
 * Forwarded messages (inbound rendering v1).
 *
 * cws-comm writes two shapes when someone forwards messages:
 *
 *   - a one-by-one copy carries message metadata
 *       forwarded_from: { version: 1, sender_id, sender_type, sender_name, sent_at, source_kind }
 *     naming the ORIGINAL author (a chain forward keeps the first author);
 *   - a merged forward is a message of type `chat_history` whose content body
 *     is `cws.chat_history.v1` ({ source, title, record_count, records[] }).
 *     The list path only has the trimmed `chat_history_preview`
 *     (`cws.chat_history.preview.v1`), and every message has the server-built
 *     `fallback_text`.
 *
 * Both are read with the same lenient rules as quote-excerpt.js: anything with
 * an unexpected shape means "not forwarded" (forwarded_from) or falls to the
 * next, smaller representation (body → preview → fallback text), and the
 * inbound text then stays exactly as for an ordinary message.
 *
 * Forwarded content was written by someone other than the forwarder, so it is
 * rendered inside its own element with every user-controlled string escaped:
 * nothing in a record can close the element or open a new <record>.
 */

export const MAX_RECORDS = 100;
export const MAX_RECORD_TEXT_CODE_POINTS = 1000;
// The whole C4 envelope reaches c4-receive as ONE argv element, which Linux
// caps at MAX_ARG_STRLEN (131072 bytes); over it the spawn fails with E2BIG and
// the message is lost. A full chat history is up to ~311 KB rendered, so the
// <forwarded-chat-history> element is held to half of that cap and the rest is
// left for the envelope around it. Records past the budget are not rendered
// and the element says how many were left out and where to read them.
export const MAX_FORWARDED_BLOCK_BYTES = 64 * 1024;
// Room kept for the opening tag's `rendered-records` attribute and the
// <records-omitted> element, which are only known after the records are laid out.
const OMITTED_RESERVE_BYTES = 512;

const CHAT_HISTORY_SCHEMA = 'cws.chat_history.v1';
const CHAT_HISTORY_PREVIEW_SCHEMA = 'cws.chat_history.preview.v1';
const SOURCE_KINDS = new Set(['dm', 'group']);

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v !== '' ? v : undefined);

/**
 * @returns {null | { senderId, senderType?, senderName?, sentAt?, sourceKind? }}
 */
export function forwardedFromOf(msg) {
  if (!isObject(msg)) return null;
  const meta = [msg.metadata, msg.message?.metadata]
    .find((m) => isObject(m) && 'forwarded_from' in m);
  return readForwardedFrom(meta?.forwarded_from, { requireVersion: true });
}

// A record's `forwarded_from` inside a chat_history body is the trimmed
// {sender_id, sender_type, sender_name} subset and has no version.
function readForwardedFrom(ff, { requireVersion }) {
  if (!isObject(ff)) return null;
  if (requireVersion && ff.version !== 1) return null;
  const senderId = str(ff.sender_id);
  if (!senderId) return null;
  return {
    senderId,
    senderType: str(ff.sender_type),
    senderName: str(ff.sender_name),
    sentAt: str(ff.sent_at),
    sourceKind: SOURCE_KINDS.has(ff.source_kind) ? ff.source_kind : undefined,
  };
}

function capText(s) {
  const chars = [...s];
  return chars.length > MAX_RECORD_TEXT_CODE_POINTS
    ? { text: chars.slice(0, MAX_RECORD_TEXT_CODE_POINTS).join(''), truncated: true }
    : { text: s, truncated: false };
}

function readRecord(r) {
  if (!isObject(r)) return null;
  const { text, truncated } = capText(typeof r.text === 'string' ? r.text : '');
  const attachments = (Array.isArray(r.attachments) ? r.attachments : [])
    .filter(isObject)
    .map((a) => ({ artifactId: str(a.artifact_id), fileName: str(a.file_name) }))
    .filter((a) => a.artifactId || a.fileName);
  const count = Number.isInteger(r.attachment_count) && r.attachment_count > 0 ? r.attachment_count : undefined;
  return {
    senderId: str(r.sender_id),
    senderType: str(r.sender_type),
    senderName: str(r.sender_name),
    sentAt: str(r.sent_at),
    type: str(r.type) || 'text',
    text,
    truncated: truncated || r.text_truncated === true,
    attachments,
    attachmentCount: count,
    forwardedFrom: readForwardedFrom(r.forwarded_from, { requireVersion: false }),
  };
}

function readHistory(h, schema) {
  if (!isObject(h) || h.schema !== schema || !Array.isArray(h.records)) return null;
  const records = h.records.slice(0, MAX_RECORDS).map(readRecord).filter(Boolean);
  const n = h.record_count;
  return {
    title: str(h.title),
    recordCount: Number.isInteger(n) && n >= 0 ? n : records.length,
    sourceKind: SOURCE_KINDS.has(h.source?.kind) ? h.source.kind : undefined,
    records,
  };
}

/**
 * A merged forward, read from the richest representation present: the full
 * body (get-message), else the list-path preview, else the fallback text.
 *
 * @returns {null
 *   | { detail: 'full' | 'preview', title?, recordCount, sourceKind?, records }
 *   | { detail: 'fallback', text }}
 */
export function chatHistoryOf(msg) {
  if (!isObject(msg)) return null;
  const type = String(msg.type || msg.message?.type || '').toLowerCase();
  if (type !== 'chat_history') return null;

  const full = readHistory(isObject(msg.content) ? msg.content.body : undefined, CHAT_HISTORY_SCHEMA);
  if (full) return { detail: 'full', ...full };
  const preview = readHistory(msg.message?.chat_history_preview ?? msg.chat_history_preview, CHAT_HISTORY_PREVIEW_SCHEMA);
  if (preview) return { detail: 'preview', ...preview };
  const text = str(msg.message?.fallback_text) || str(msg.fallback_text)
    || str(msg.message?.content) || str(msg.content);
  return text ? { detail: 'fallback', text } : null;
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;').replace(/[\r\n\u2028\u2029]+/g, ' ');
}

function attrs(pairs) {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('');
}

function originalSenderAttrs(ff) {
  if (!ff) return [];
  return [
    ['original-sender', ff.senderName || ff.senderId],
    ['original-sender-kind', ff.senderType],
    ['original-sent-at', ff.sentAt],
  ];
}

const TYPE_LABEL = {
  image: '[图片]', file: '[文件]', audio: '[语音]', video: '[视频]', chat_history: '[会话记录]',
};

function recordBody(r) {
  // A nested chat history is a placeholder only: its records are never copied.
  if (r.type === 'chat_history') return TYPE_LABEL.chat_history;
  const label = TYPE_LABEL[r.type];
  if (!label) return r.text;
  return r.text ? `${label} ${r.text}` : label;
}

function formatRecord(r) {
  const files = r.attachments
    .map((a) => (a.artifactId ? `${a.fileName || 'unknown'}(artifact_id=${a.artifactId})` : a.fileName))
    .join(', ');
  const a = attrs([
    ['sender', r.senderName || r.senderId || 'unknown'],
    ['sender-kind', r.senderType],
    ['sent-at', r.sentAt],
    ...originalSenderAttrs(r.forwardedFrom),
    ['attachments', files],
    ['attachment-count', r.attachmentCount],
    ['text-truncated', r.truncated ? 'true' : undefined],
  ]);
  return `<record${a}>${escapeText(recordBody(r))}</record>`;
}

/** One-by-one forwarded copy: the original text inside <forwarded-message>. */
export function formatForwardedMessage(forwarder, ff, content) {
  if (!ff) return '';
  const a = attrs([
    ['forwarded-by', forwarder || 'unknown'],
    ...originalSenderAttrs(ff),
    ['source-kind', ff.sourceKind],
  ]);
  return `<forwarded-message${a}>\n${escapeText(content ?? '')}\n</forwarded-message>`;
}

const byteLength = (s) => Buffer.byteLength(s, 'utf8');

// Longest prefix of `s` whose escaped form fits in `budget` bytes.
function escapedPrefix(s, budget) {
  const out = [];
  let used = 0;
  for (const ch of s) {
    const e = escapeText(ch);
    const n = byteLength(e);
    if (used + n > budget) return { text: out.join(''), truncated: true };
    out.push(e);
    used += n;
  }
  return { text: out.join(''), truncated: false };
}

const CLOSE = '</forwarded-chat-history>';

/**
 * Merged forward: one <record> per message. `ff` is set when the card itself
 * was forwarded one-by-one (its original sender is the one who merged it).
 * The result never exceeds MAX_FORWARDED_BLOCK_BYTES.
 */
export function formatForwardedChatHistory(forwarder, history, ff) {
  if (!history) return '';
  const head = [['forwarded-by', forwarder || 'unknown'], ...originalSenderAttrs(ff)];
  if (history.detail === 'fallback') {
    const open = `<forwarded-chat-history${attrs([...head, ['detail', 'fallback']])}`;
    const room = MAX_FORWARDED_BLOCK_BYTES - byteLength(open) - byteLength(CLOSE) - OMITTED_RESERVE_BYTES;
    const { text, truncated } = escapedPrefix(history.text, Math.max(0, room));
    const mark = truncated ? ' text-truncated="true"' : '';
    return `${open}${mark}>\n${text}\n${CLOSE}`;
  }
  const a = attrs([
    ...head,
    ['title', history.title],
    ['record-count', history.recordCount],
    ['source-kind', history.sourceKind],
    ['detail', history.detail === 'preview' ? 'preview' : undefined],
  ]);
  let room = MAX_FORWARDED_BLOCK_BYTES - byteLength(`<forwarded-chat-history${a}>\n${CLOSE}`) - OMITTED_RESERVE_BYTES;
  const lines = [];
  for (const r of history.records) {
    const line = formatRecord(r);
    const n = byteLength(line) + 1;
    if (n > room) break;
    lines.push(line);
    room -= n;
  }
  const omitted = history.records.length - lines.length;
  if (omitted > 0) {
    lines.push(`<records-omitted count="${omitted}">Left out to keep this message within the delivery size limit. `
      + 'Read every record with comm.get_message, using the conversation-id and source-message-id of message-context.'
      + '</records-omitted>');
  }
  const rendered = omitted > 0 ? ` rendered-records="${history.records.length - omitted}"` : '';
  const body = lines.join('\n');
  return `<forwarded-chat-history${a}${rendered}>\n${body}${body ? '\n' : ''}${CLOSE}`;
}

/**
 * Short marker for a forwarded message shown as a context line (group history,
 * the message being replied to), so it is not read as the sender's own words:
 * "forwarded from <original author>" or "forwarded chat history".
 */
export function forwardedLabelOf(msg) {
  const ff = forwardedFromOf(msg);
  if (ff) return `forwarded from ${ff.senderName || ff.senderId}`;
  const type = isObject(msg) ? String(msg.type || msg.message?.type || '').toLowerCase() : '';
  return type === 'chat_history' ? 'forwarded chat history' : undefined;
}
