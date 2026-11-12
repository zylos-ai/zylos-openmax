/**
 * Sub-conversations (cws-comm#373): a conversation that lives under a parent
 * DM or group, owned by an app (any context key, e.g. `ticket:42`) or by the
 * platform (a reply topic, key `message:<root message id>`).
 *
 * Everything here is pure, so the bridge's decisions can be unit-tested:
 *   - subConversationOf: is this conversation record a sub-conversation?
 *   - groupScopeConversationId: which conversation's group config gates it;
 *   - appSubConversationAddressesAgent: the one switch for app
 *     sub-conversations in a group (see there);
 *   - fetchesConversationContext: who gets local history and a context block;
 *   - pinRootMessage: a sub-conversation's root message first in that block.
 *
 * Only the conversation record (GET /conversations/{id}) is read, never message
 * metadata, so a sender cannot make an ordinary conversation look like one.
 * Generic by design: no context key, owner app or title is special-cased, and
 * none of them reaches the envelope.
 */

// The two owner kinds cws-comm writes (context_owner_kind).
const OWNER_KINDS = new Set(['app', 'platform']);

// cws-comm's context key rule.
const CONTEXT_KEY_RE = /^[a-z0-9:_-]{1,128}$/;

// A message id: cws-comm's int64, as a string of digits.
const MESSAGE_ID_RE = /^[1-9][0-9]*$/;

// A platform reply topic's key names its root message (cws-comm
// ReplyTopicRootMessageID): `message:` and a positive integer id.
const ROOT_KEY_RE = /^message:([1-9][0-9]*)$/;

// The record's own root_message_id (not returned by cws-core yet; read when it
// is): a digit string, or a positive safe-integer JSON number.
function rootMessageIdField(v) {
  if (typeof v === 'string' && MESSAGE_ID_RE.test(v)) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0) return String(v);
  return undefined;
}

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * Read a conversation record as a sub-conversation.
 *
 * All of these, or it is not one (fail closed: anything missing or malformed
 * keeps the ordinary handling):
 *   - context_owner_kind is `app` or `platform`;
 *   - context_key matches the server's rule;
 *   - parent_conversation_id is set (the group gate needs it);
 *   - for `app`, context_owner_app_id is set.
 * A legacy thread with only parent_conversation_id is not a sub-conversation.
 *
 * `rootMessageId`, for any sub-conversation (app or platform), in order:
 *   1. the record's `root_message_id`, when present and well-formed;
 *   2. for a platform topic, the id in a `message:<id>` key (an app key that
 *      happens to read `message:5` is not parsed: the server resolves keys to
 *      root messages for platform owners only).
 * None known → no rootMessageId (just the recent lines).
 *
 * @param {object|null|undefined} conv  GET /conversations/{id} response
 * @returns {{parentConversationId:string, ownerKind:'app'|'platform', rootMessageId?:string}|null}
 */
export function subConversationOf(conv) {
  if (!conv || typeof conv !== 'object') return null;
  const ownerKind = conv.context_owner_kind;
  if (typeof ownerKind !== 'string' || !OWNER_KINDS.has(ownerKind)) return null;
  const key = conv.context_key;
  if (typeof key !== 'string' || !CONTEXT_KEY_RE.test(key)) return null;
  if (!nonEmptyString(conv.parent_conversation_id)) return null;
  if (ownerKind === 'app' && !nonEmptyString(conv.context_owner_app_id)) return null;

  const sub = { parentConversationId: conv.parent_conversation_id, ownerKind };
  let rootMessageId = rootMessageIdField(conv.root_message_id);
  if (!rootMessageId && ownerKind === 'platform') rootMessageId = ROOT_KEY_RE.exec(key)?.[1];
  if (rootMessageId) sub.rootMessageId = rootMessageId;
  return sub;
}

/**
 * The conversation whose group config (`access.groups[id]`: allowlist entry,
 * mode, allowFrom) gates a group message: the parent group for a
 * sub-conversation, as if the message had been sent in the parent group; the
 * conversation itself otherwise. A sub-conversation's own id in `groups{}`
 * does not let it through.
 */
export function groupScopeConversationId(conversationId, sub) {
  return sub ? sub.parentConversationId : conversationId;
}

// Q1 switch, pending confirmation. false: an app sub-conversation in a group
// follows the parent group's mode like any other group message (mention mode
// needs an @; smart mode lets the Agent decide), as platform topics do and as
// zylos-lark treats thread messages. true: every message of an app
// sub-conversation in a group counts as addressed to the Agent, without an @
// (cws-comm design decision 15); it still has to pass the parent group's
// allowlist and allowFrom.
const APP_SUBCONVERSATION_IN_GROUP_ADDRESSES_AGENT = false;

/**
 * Whether a group message in this sub-conversation counts as addressed to the
 * Agent without an @ (see the switch above). Only consulted for group
 * sub-conversations; a DM sub-conversation is a DM.
 */
export function appSubConversationAddressesAgent(sub) {
  return APP_SUBCONVERSATION_IN_GROUP_ADDRESSES_AGENT && sub?.ownerKind === 'app';
}

/**
 * Whether the bridge records a message into local history and gives it a
 * context block: every non-DM conversation, as before, and every
 * sub-conversation, a DM one included (keyed by the sub-conversation's own
 * id). A plain DM gets neither.
 */
export function fetchesConversationContext(convType, sub) {
  return convType !== 'dm' || !!sub;
}

function sameId(a, b) {
  return a != null && b != null && String(a) === String(b);
}

/**
 * Put a sub-conversation's root message first in its context lines (zylos-lark
 * pinRootMessage). In the window: moved to the front, kept once. Not in it:
 * `lookup(rootMessageId)` (a line in `recent`'s shape, or null; the caller
 * resolves it from local history or the parent conversation) is put first.
 * Found nowhere, or the current message is the root (it is already in
 * <current-message>): the lines are returned unchanged.
 *
 * @param {Array<{messageId?:string}>} recent
 * @param {string|undefined} rootMessageId
 * @param {{currentMessageId?:string, lookup?:(id:string)=>object|null}} [opts]
 * @returns {Array}
 */
export function pinRootMessage(recent, rootMessageId, { currentMessageId, lookup } = {}) {
  if (!rootMessageId || !Array.isArray(recent)) return recent;
  if (sameId(currentMessageId, rootMessageId)) return recent;
  const idx = recent.findIndex((m) => sameId(m?.messageId, rootMessageId));
  if (idx === 0) return recent;
  if (idx > 0) {
    const out = [...recent];
    const [root] = out.splice(idx, 1);
    out.unshift(root);
    return out;
  }
  const line = typeof lookup === 'function' ? lookup(rootMessageId) : null;
  return line ? [line, ...recent] : recent;
}
