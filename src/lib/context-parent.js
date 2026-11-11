/**
 * Which message a new message inherits metadata.context items from
 * (OPENM-1351, plan §4.B / §4.C), and the replied-to message for <replying-to>.
 *
 * - In a thread the parent is the thread ROOT, not the message being replied
 *   to inside the thread. A thread is recognised by the frame's `thread_id`, or
 *   by the conversation type STRAT (cws-core's renamed THREAD; `thread` is
 *   still accepted); its root is the frame's `parent_message_id`. A #373 reply
 *   topic (a sub-conversation whose usable `subconversation` item has the key
 *   `message:<root id>`) names its root the same way.
 * - The root lives in the conversation the thread hangs off. A STRAT
 *   conversation names it in `parent_id` (cws-core contract, see
 *   src/cli/conn.js resolveGuardConversationType; `parent_conversation_id` is
 *   accepted too). When the frame's own conversation is the thread, its parent
 *   is tried first; when the frame names the main conversation (with
 *   `thread_id`), that one is.
 * - Outside a thread the parent is the replied-to message itself.
 *
 * Roots are fetched through one cache (createContextRootFetcher), so every
 * message of a thread costs no fetch once its root is known, a missing root is
 * remembered for a short while, and a <replying-to> that IS the root reuses
 * that fetch instead of making its own. Trade-off: an edit to the root's text
 * shows in <replying-to> only once the cached copy expires (5 minutes).
 */

import { createThreadRootCache, usableContextItem } from './message-context.js';

const lower = (v) => String(v || '').toLowerCase();
const THREAD_TYPES = new Set(['strat', 'thread']);

/** `{ rootId, conversationIds }` when `msg` is in a thread, else null. */
export function threadRootOf(msg, conv, { trusted = false } = {}) {
  if (!msg || typeof msg !== 'object') return null;
  const isThreadConv = THREAD_TYPES.has(lower(conv?.type));
  const parentConvId = conv?.parent_id ?? conv?.parent_conversation_id;
  let rootId = (msg.thread_id || msg.message?.thread_id || isThreadConv)
    ? (msg.parent_message_id || msg.message?.parent_message_id)
    : undefined;
  if (!rootId) {
    const key = usableContextItem(msg, 'subconversation', { trusted })?.attrs?.key;
    const m = typeof key === 'string' ? /^message:(.+)$/.exec(key) : null;
    if (m) rootId = m[1];
  }
  if (!rootId) return null;
  const order = isThreadConv ? [parentConvId, msg.conversation_id] : [msg.conversation_id, parentConvId];
  const conversationIds = [...new Set(order.filter(Boolean).map(String))];
  return conversationIds.length ? { rootId: String(rootId), conversationIds } : null;
}

function conversationOf(m) {
  return m?.message?.conversation_id ?? m?.conversation_id;
}

/**
 * Fetches thread roots through a cache keyed by org, candidate conversations
 * and root id. `fetchMessage(orgId, conversationId, messageId)` resolves to the
 * message detail or null. A fetched message whose conversation_id is known and
 * is not the conversation asked is not taken as the root.
 */
export function createContextRootFetcher({ fetchMessage, cache = createThreadRootCache() }) {
  return {
    cache,
    async get(orgId, rootId, conversationIds) {
      const key = `${orgId}|${conversationIds.join(',')}|${rootId}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      for (const convId of conversationIds) {
        const m = await fetchMessage(orgId, convId, rootId);
        const at = conversationOf(m);
        if (m && (at === undefined || at === null || String(at) === String(convId))) {
          cache.set(key, m);
          return m;
        }
      }
      cache.set(key, null);
      return null;
    },
  };
}

/**
 * The replied-to message (for <replying-to>; not fetched in a legacy `thread`
 * conversation, as before) and the message to inherit context from.
 *
 * @returns {Promise<{ quotedMsgId, quoted: object|null, contextParent: object|undefined }>}
 */
export async function resolveContextParent({ orgId, msg, conv, convType, trusted = false, roots, fetchMessage }) {
  const quotedMsgId = msg.parent_id || msg.message?.parent_id || msg.parent_message_id;
  const root = threadRootOf(msg, conv, { trusted });
  let quoted = null;
  if (quotedMsgId && convType !== 'thread') {
    quoted = (root && String(quotedMsgId) === root.rootId)
      ? await roots.get(orgId, root.rootId, root.conversationIds)
      : await fetchMessage(orgId, msg.conversation_id, quotedMsgId);
  }
  const contextParent = root ? await roots.get(orgId, root.rootId, root.conversationIds) : quoted;
  return { quotedMsgId, quoted: quoted || null, contextParent: contextParent || undefined };
}
