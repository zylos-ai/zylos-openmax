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
 * Each line is `{ senderName, senderId, content, messageId }`; formatContextLine
 * (message.js) reads only the name and content.
 */

import { getHistory, findHistoryEntry } from './group-history.js';
import { pinRootMessage } from './subconversation.js';
import { isChatHistory, FORWARDED_CONVERSATION } from './forwarded.js';
import { formatStructuredForModel } from './structured-body.js';
import { quotedMessageText } from './quote-excerpt.js';

/** A local history entry as a context line. */
export async function localEntryToContext(e, resolveName) {
  let name = e.sender_name;
  // Resolve sender names for entries stored with raw IDs (cold-start replay
  // or entries recorded before names were stored).
  if (!name || name === e.sender_id) {
    name = (await resolveName(e.sender_id)) || e.sender_id;
  }
  return { senderName: name, senderId: e.sender_id, content: e.text, messageId: e.message_id };
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
  return { senderName, senderId: m.sender_id, content, messageId: m.id };
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

// Root message lines fetched from the parent conversation, per
// sub-conversation id: { rootMessageId, line } (line null = recalled or
// deleted, nothing to show). A root does not change; a recall or edit of it
// drops the entry (forgetRootMessage). A failed fetch is not cached.
const ROOT_CACHE_MAX = 500;
const rootLineCache = new Map();

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * A single-message read (GET /conversations/{id}/messages/{messageId}, the
 * `{ message, content }` detail) as a context line; null when it was recalled
 * or deleted or has nothing to show.
 */
export async function messageDetailToContext(detail, resolveName) {
  const m = detail?.message || {};
  if (m.recalled_by || m.deleted_at) return null;
  const structured = (detail?.content && typeof detail.content === 'object') ? detail.content : {};
  let content = isChatHistory(detail) ? FORWARDED_CONVERSATION : quotedMessageText(detail);
  const atts = Array.isArray(structured.attachments) ? structured.attachments : [];
  if (atts.length > 0) {
    const type = String(m.type || '').toLowerCase();
    const kind = type === 'image' || type === 'agent_card' ? 'image' : 'file';
    const labels = atts.map(a => `[${kind}: ${a.artifact_id} | ${a.file_name || 'unknown'}]`);
    content = labels.join(' ') + (content ? ' ' + content : '');
  }
  if (!content) return null;
  const senderId = m.sender_id;
  const senderName = m.sender_display_name || (await resolveName(senderId)) || senderId;
  return { senderName, senderId, content, messageId: m.id ?? null };
}

/** Drop any cached root line for this message id (it was recalled or edited). */
export function forgetRootMessage(messageId) {
  for (const [key, v] of rootLineCache) {
    if (sameId(v.rootMessageId, messageId)) rootLineCache.delete(key);
  }
}

async function fetchedRootLine(conversationId, rootMessageId, fetchRoot, resolveName) {
  const key = String(conversationId);
  const hit = rootLineCache.get(key);
  if (hit && sameId(hit.rootMessageId, rootMessageId)) return hit.line;
  const detail = await fetchRoot(rootMessageId);
  if (!detail) return null;   // fetch failed: not cached, tried again next message
  const line = await messageDetailToContext(detail, resolveName);
  if (line) line.messageId = String(rootMessageId);
  rootLineCache.set(key, { rootMessageId: String(rootMessageId), line });
  if (rootLineCache.size > ROOT_CACHE_MAX) rootLineCache.delete(rootLineCache.keys().next().value);
  return line;
}

/**
 * Put a sub-conversation's root message first in `recent` (see pinRootMessage),
 * once: moved when it is in the window; else taken from this conversation's
 * local history; else read with `fetchRoot(rootMessageId)` (the single-message
 * read in the parent conversation, which returns the detail or null on error)
 * and cached per sub-conversation. A failed read, or a recalled / deleted
 * root, adds no line; the other lines are unchanged.
 *
 * @param {Array} recent  gatherRecentContext lines
 * @param {{conversationId:string, rootMessageId:string, currentMessageId?:string,
 *          resolveName:Function, fetchRoot?:Function}} p
 */
export async function rootMessageFirst(recent, { conversationId, rootMessageId, currentMessageId, resolveName, fetchRoot }) {
  if (!rootMessageId || sameId(currentMessageId, rootMessageId)) return recent;
  if (recent.some((m) => sameId(m.messageId, rootMessageId))) {
    return pinRootMessage(recent, rootMessageId, { currentMessageId });
  }
  const entry = findHistoryEntry(conversationId, rootMessageId);
  let rootLine = entry ? await localEntryToContext(entry, resolveName) : null;
  if (!rootLine && typeof fetchRoot === 'function') {
    rootLine = await fetchedRootLine(conversationId, rootMessageId, fetchRoot, resolveName);
  }
  return pinRootMessage(recent, rootMessageId, { currentMessageId, lookup: () => rootLine });
}
