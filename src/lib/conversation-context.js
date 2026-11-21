/**
 * Recent-message context for an inbound message: the lines of <group-context>
 * (group / thread) and <subconversation-context> (sub-conversations).
 *
 * Source priority: local history (memory → file replay, group-history.js) when
 * it has `baseLimit` entries, else one GET /conversations/{id}/messages page
 * (`before_seq` = the message's seq, `limit` = baseLimit). When the window or
 * the current message replies to a message outside it, the window grows up to
 * `maxLimit` (local) or by one more page (API).
 *
 * I/O is passed in so this can be unit-tested: `fetchRecent(conversationId,
 * beforeSeq, limit)` returns API message objects ([] on failure);
 * `resolveName(memberId)` returns a display name or null.
 *
 * Each line is `{ senderName, senderId, content, messageId }` (formatContextLine
 * in message.js renders it).
 *
 * cws-comm does not echo a sender's own messages back to it, so the Agent's own
 * replies never arrive as inbound frames. recordSentMessage puts them into local
 * history (send.js hands each sent message to the bridge, see dm-seen-watch.js),
 * so a context built from local history has them like the API page does.
 */

import { getHistory, hasHistory, ensureReplay, logAndRecord } from './group-history.js';
import { isChatHistory, FORWARDED_CONVERSATION } from './forwarded.js';
import { formatStructuredForModel } from './structured-body.js';

/** A local history entry as a context line. */
async function localEntryToContext(e, resolveName) {
  let name = e.sender_name;
  // Resolve sender names for entries stored with raw IDs (cold-start replay
  // or entries recorded before names were stored).
  if (!name || name === e.sender_id) {
    name = (await resolveName(e.sender_id)) || e.sender_id;
  }
  return { senderName: name, senderId: e.sender_id, content: e.text, messageId: idString(e.message_id) };
}

function idString(id) {
  return id == null || id === '' ? null : String(id);
}

async function apiMessageToContext(m, resolveName) {
  const senderName = m.sender_display_name
           || m.senderName
           || (await resolveName(m.sender_id))
           || m.sender_id;
  const mStructured = (m.content && typeof m.content === 'object') ? m.content : {};
  const text = mStructured.body?.text
           || (typeof m.content === 'string' ? m.content : '')
           || m.content_text
           // Same hole as the forward path: without this a card already in
           // history renders as an empty turn in the replayed context.
           || formatStructuredForModel(m)
           || '';
  const mType = (m.type || m.message?.type || '').toLowerCase();
  const mAttachments = Array.isArray(mStructured.attachments) ? mStructured.attachments
                     : Array.isArray(m.attachments) ? m.attachments : [];
  const mIsImage = mType === 'image' || mType === 'agent_card';
  const mIsFile = !mIsImage && (mType === 'file' || mAttachments.length > 0);
  let content = text;
  if ((mIsImage || mIsFile) && mAttachments.length > 0) {
    const kind = mIsImage ? 'image' : 'file';
    const labels = mAttachments.map(a => `[${kind}: ${a.artifact_id} | ${a.file_name || 'unknown'}]`);
    content = labels.join(' ') + (text ? ' ' + text : '');
  } else if (mIsImage) {
    content = '[image]' + (text ? ' ' + text : '');
  }
  if (isChatHistory(m)) content = FORWARDED_CONVERSATION;
  return { senderName, senderId: m.sender_id, content, messageId: idString(m.id) };
}

/**
 * What a sub-conversation's context has already given the Agent, so
 * <subconversation-context> carries only the lines it has not seen: each
 * message forwarded (as the current message or as a context line) is
 * remembered by id per conversation, and `unseen` leaves those lines out.
 * A line without an id is always kept. In memory only: after a bridge restart
 * the next context is whole again. Bounded: the newest `maxIds` ids per
 * conversation, the `maxConversations` most recently used conversations.
 */
export function createContextDelivery({ maxIds = 200, maxConversations = 1000 } = {}) {
  const delivered = new Map();   // conversationId -> Set<messageId>, oldest first

  return {
    unseen(conversationId, lines) {
      const seen = delivered.get(String(conversationId));
      if (!seen) return lines;
      return lines.filter((l) => !l.messageId || !seen.has(String(l.messageId)));
    },
    remember(conversationId, ids) {
      const key = String(conversationId);
      const seen = delivered.get(key) || new Set();
      delivered.delete(key);
      for (const id of ids) {
        if (id == null || id === '') continue;
        seen.delete(String(id));
        seen.add(String(id));
      }
      while (seen.size > maxIds) seen.delete(seen.values().next().value);
      delivered.set(key, seen);
      while (delivered.size > maxConversations) delivered.delete(delivered.keys().next().value);
    },
  };
}

/**
 * The local history entry for a message: the get-message response merged over
 * the frame (`msg.message` holds the scalar fields, `msg.content` the
 * structured body). Media become labels; a merged forward is one line.
 */
export function historyEntryOf(msg, senderName, timestamp = new Date().toISOString()) {
  const structured = (msg.content && typeof msg.content === 'object') ? msg.content : {};
  const entryText = structured.body?.text
    || (typeof msg.message?.content === 'string' ? msg.message.content : '')
    || (typeof msg.content === 'string' ? msg.content : '')
    || '';
  const msgType = (msg.type || msg.message?.type || '').toLowerCase();
  const atts = Array.isArray(structured.attachments) ? structured.attachments : [];
  const isImg = msgType === 'image' || msgType === 'agent_card';
  let histText = entryText;
  if ((isImg || atts.length > 0) && atts.length > 0) {
    const kind = isImg ? 'image' : 'file';
    const labels = atts.map(a => `[${kind}: ${a.artifact_id || '?'} | ${a.file_name || 'unknown'}]`);
    histText = labels.join(' ') + (entryText ? ' ' + entryText : '');
  } else if (isImg) {
    histText = '[image]' + (entryText ? ' ' + entryText : '');
  }
  // A merged forward is one line in context, never its expanded records.
  if (isChatHistory(msg)) histText = FORWARDED_CONVERSATION;
  const seq = msg.seq ?? msg.message?.seq;
  return {
    timestamp,
    message_id: msg.id ?? msg.message?.id,
    sender_id: msg.sender_id || msg.message?.sender_id,
    sender_name: senderName,
    text: histText,
    seq: seq != null ? Number(seq) : null,
    parent_id: msg.parent_message_id || msg.message?.parent_message_id || msg.message?.parent_id || null,
    type: msgType || 'text',
  };
}

/**
 * Record a message this Agent sent into local history, when history is kept
 * for its conversation. `fetchDetail()` returns the get-message response (null
 * on failure: nothing is recorded). Returns whether an entry was recorded.
 */
export async function recordSentMessage({ conversationId, messageId, fetchDetail, resolveName }) {
  if (!conversationId || !messageId || !hasHistory(conversationId)) return false;
  const detail = await fetchDetail();
  if (!detail) return false;
  const msg = { id: messageId, ...detail };
  const senderId = msg.sender_id || msg.message?.sender_id;
  const senderName = msg.sender_display_name
    || msg.message?.sender_display_name
    || (await resolveName(senderId))
    || senderId;
  // Replay first, so a log file not yet read by this process is read before
  // the new entry (otherwise the tail would land after it in memory).
  ensureReplay(conversationId);
  logAndRecord(conversationId, historyEntryOf(msg, senderName));
  return true;
}

/**
 * @param {object} p
 * @param {string} p.conversationId
 * @param {string} p.messageId        the current message (left out of the lines)
 * @param {number} [p.seq]            the current message's seq (API before_seq)
 * @param {string} [p.parentId]       the message the current one replies to
 * @param {number} p.baseLimit        config.message.context_messages
 * @param {number} p.maxLimit         config.message.context_max_messages
 * @param {Function} p.fetchRecent
 * @param {Function} p.resolveName
 * @param {Function} [p.log]
 * @returns {Promise<{recent:Array, source:'local'|'api'|'api+local'}>}
 */
export async function gatherRecentContext({
  conversationId, messageId, seq, parentId, baseLimit, maxLimit, fetchRecent, resolveName, log = () => {},
}) {
  // Context source priority: memory → file replay → API fallback.
  // The caller already ensured replay + recorded this message.
  // If local has data but fewer than baseLimit, fall back to API for a
  // fuller window (e.g. right after deployment when history is thin).
  const localCtx = getHistory(conversationId, messageId, baseLimit);
  let ctx;
  let source;
  if (localCtx && localCtx.length >= baseLimit) {
    source = 'local';
    ctx = localCtx;
  } else {
    source = localCtx && localCtx.length > 0 ? 'api+local' : 'api';
    ctx = await fetchRecent(conversationId, seq, baseLimit);
  }

  // Dynamic expansion: if context or the current message reference parent
  // messages (replies) not in the window, expand to capture the reply chain.
  if (source === 'local') {
    const ctxByMsgId = new Set(ctx.map(e => e.message_id));
    const missingParentIds = new Set();
    if (parentId && !ctxByMsgId.has(parentId)) missingParentIds.add(parentId);
    for (const e of ctx) {
      if (e.parent_id && !ctxByMsgId.has(e.parent_id)) missingParentIds.add(e.parent_id);
    }
    if (missingParentIds.size > 0 && ctx.length < maxLimit) {
      const expanded = getHistory(conversationId, messageId, maxLimit);
      if (expanded && expanded.length > ctx.length) {
        ctx = expanded;
        log(`context expanded (local): ${baseLimit} → ${ctx.length} msgs (${missingParentIds.size} missing parent(s))`);
      }
    }
    const ctxSorted = [...ctx].sort((a, b) => (a.seq || 0) - (b.seq || 0));
    const recent = await Promise.all(ctxSorted.map(e => localEntryToContext(e, resolveName)));
    return { recent, source };
  }

  // API path: ctx is an array of API message objects
  const ctxById = new Map(ctx.map(m => [m.id, m]));
  const missingParentIds = new Set();
  if (parentId && !ctxById.has(parentId)) missingParentIds.add(parentId);
  for (const m of ctx) {
    const pid = m.parent_id || m.parent_message_id;
    if (pid && !ctxById.has(pid)) missingParentIds.add(pid);
  }
  if (missingParentIds.size > 0 && ctx.length < maxLimit) {
    const expandCount = Math.min(maxLimit, baseLimit * 3) - ctx.length;
    if (expandCount > 0) {
      const oldestSeq = ctx.reduce((min, m) => Math.min(min, Number(m.seq) || Infinity), Infinity);
      if (oldestSeq < Infinity) {
        const extra = await fetchRecent(conversationId, oldestSeq, expandCount);
        for (const m of extra) {
          if (!ctxById.has(m.id)) {
            ctxById.set(m.id, m);
            ctx.push(m);
          }
        }
        log(`context expanded (api): ${baseLimit} → ${ctx.length} msgs (${missingParentIds.size} missing parent(s))`);
      }
    }
  }

  const ctxAsc = [...ctx].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  const recent = await Promise.all(ctxAsc.map(m => apiMessageToContext(m, resolveName)));
  return { recent, source };
}
