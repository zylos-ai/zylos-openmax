#!/usr/bin/env node

/**
 * Communication bridge — PM2 service entry point.
 *
 * Multi-org architecture:
 *   1. Reads `config.orgs.*` (enabled entries only).
 *   2. Opens ONE WebSocket per enabled org. Each connection is independent:
 *      its own urlProvider (per-org ws-ticket), its own message handler bound
 *      to that org's identity and access policy, its own reconnect lifecycle.
 *   3. Inbound `message` frames go through per-org `shouldHandleMessage`
 *      (lark-style dmPolicy / groupPolicy / per-group config / owner) before
 *      being forwarded to C4.
 *   4. A single org going terminal (4002/4005/4006) only stops that org's
 *      WS; other orgs keep running. The process exits only if every enabled
 *      org has gone terminal.
 *
 * Conversation type lookup: when an inbound message arrives, the frame
 * carries conversation_id but not the conversation type. We fetch the
 * conversation via REST once and cache it for the dedup TTL window.
 */

import path from 'path';
import { execFile } from 'child_process';

import { loadConfig, watchConfig, enabledOrgs, bindOwner, setOwner, updateOwnerName } from './lib/config.js';
import { WsClient, createDeduper } from './lib/ws.js';
import { formatInboundForC4, formatEndpoint, newClientMsgId } from './lib/message.js';
import { recordParticipants } from './lib/mention.js';
import { getMediaUrl, downloadMedia } from './cli/as.js';
import { getForOrg, postForOrg, apiPath } from './lib/client.js';
import { getAccessToken, getWsTicket, invalidate as invalidateToken } from './lib/token.js';
import { loadOrgSession, saveOrgSession, RUNTIME_DIR } from './lib/session.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'coco-workspace';

// Hardcoded message defaults (aligned with zylos-lark). `config.message.*`
// may override either; if absent, these apply. Operator-edited config.json
// files don't need to mention `message` at all.
const DEFAULT_CONTEXT_MESSAGES = 5;
const DEFAULT_DEDUP_TTL_MS     = 5 * 60 * 1000;   // 300_000
const DEFAULT_DEDUP_MAX_ENTRIES = 500;

// Hardcoded WS operational defaults. `config.server.{reconnect_max_delay,
// heartbeat_interval}` may override either; if absent, these apply.
const DEFAULT_WS_RECONNECT_MAX_MS = 30 * 1000;    // 30_000
const DEFAULT_WS_HEARTBEAT_MS     = 30 * 1000;    // 30_000

const C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js',
);
const C4_CONTROL = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-control.js',
);

function log(...a)  { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }

let config = loadConfig();
// Persist the deduper's seen-id window to disk (runtime/dedup.json) so a
// restart/reconnect catch-up re-pull is deduped by message_id. Retention is
// count-based: keep the most recent `maxEntries` ids. A reconnect/restart
// catch-up can re-pull up to SYNC_MAX_EVENTS (2000) events at once, so the
// window must be large enough to span a whole catch-up — otherwise ids beyond
// the window age out mid-catch-up and the tail replays as "new" messages.
// Overridable via `config.message.dedup_max_entries`; default 500 covers normal
// restarts and typical catch-ups. Raise toward SYNC_MAX_EVENTS for longer outages.
const DEDUP_PATH = path.join(RUNTIME_DIR, 'dedup.json');
const dedupe = createDeduper(
  config.message?.dedup_ttl ?? DEFAULT_DEDUP_TTL_MS,
  { persistPath: DEDUP_PATH, maxEntries: config.message?.dedup_max_entries ?? DEFAULT_DEDUP_MAX_ENTRIES },
);

// org_id → cached Conversation row (response_mode no longer used for filter
// but other fields like `type` are still useful)
const conversationCache = new Map();

// `${orgId}:${memberId}` → resolved display name. Member display names are
// stable for the life of the process; caching avoids a /members/{id} lookup
// per inbound message (and per context line) for the same sender.
const memberNameCache = new Map();

// message_id → { text, ts }. TTL slightly over 2 min (the recall window).
const MSG_TEXT_TTL_MS = 130_000;
const recentMsgTextCache = new Map();

function cacheMessageText(messageId, text) {
  if (!messageId || !text) return;
  recentMsgTextCache.set(messageId, { text, ts: Date.now() });
  // Lazy eviction: prune expired entries when cache grows past 500
  if (recentMsgTextCache.size > 500) {
    const now = Date.now();
    for (const [k, v] of recentMsgTextCache) {
      if (now - v.ts > MSG_TEXT_TTL_MS) recentMsgTextCache.delete(k);
    }
  }
}

function getCachedMessageText(messageId) {
  const entry = recentMsgTextCache.get(messageId);
  if (!entry) return '';
  if (Date.now() - entry.ts > MSG_TEXT_TTL_MS) {
    recentMsgTextCache.delete(messageId);
    return '';
  }
  return entry.text;
}

// =============================================================================
// REST helpers
// =============================================================================

/**
 * Resolve a member's display name from cws-core, cached per process.
 * Returns null when the member can't be resolved (caller falls back to the id).
 */
async function fetchMemberName(orgId, memberId) {
  if (!memberId) return null;
  const key = `${orgId}:${memberId}`;
  if (memberNameCache.has(key)) return memberNameCache.get(key);
  try {
    const m = await getForOrg(orgId, apiPath(`/members/${memberId}`));
    const name = m?.display_name || m?.username || null;
    if (name) memberNameCache.set(key, name);
    return name;
  } catch (e) {
    warn(`fetchMemberName ${memberId} failed:`, e.message);
    return null;
  }
}

async function fetchConversation(orgId, conversationId) {
  if (conversationCache.has(conversationId)) return conversationCache.get(conversationId);
  try {
    const conv = await getForOrg(orgId, apiPath(`/conversations/${conversationId}`));
    conversationCache.set(conversationId, conv);
    return conv;
  } catch (e) {
    warn(`fetchConversation ${conversationId} failed:`, e.message);
    return null;
  }
}

async function fetchRecentMessages(orgId, conversationId, beforeSeq, limit) {
  try {
    const r = await getForOrg(orgId, apiPath(`/conversations/${conversationId}/messages`), {
      before_seq: beforeSeq,
      limit:      limit || 10,
    });
    return Array.isArray(r) ? r : (r?.data || r?.messages || r?.items || []);
  } catch (e) {
    warn('fetchRecentMessages failed:', e.message);
    return [];
  }
}

async function fetchMessageDetail(orgId, conversationId, messageId) {
  try {
    return await getForOrg(orgId, apiPath(`/conversations/${conversationId}/messages/${messageId}`));
  } catch (e) {
    warn(`fetchMessageDetail conv=${conversationId} msg=${messageId} failed:`, e.message);
    return null;
  }
}

/**
 * Send a brief refusal back to the sender when shouldHandleMessage drops a
 * message with a userNotice set. Posted as a reply (parent_id = original) so
 * the sender sees it in-thread on clients that render reply chains. Errors
 * are logged and swallowed — we never want a reject-notice failure to mask
 * the underlying drop decision.
 */
async function sendRejectNotice(orgConfig, msg, text) {
  try {
    await postForOrg(
      orgConfig.org_id,
      apiPath(`/conversations/${msg.conversation_id}/messages`),
      {
        client_msg_id: newClientMsgId(),
        type:          'AGENT_TEXT',
        content: {
          content_type: 'text',
          body:         { text },
          attachments:  [],
        },
        // cws-core's sendMessageRequest expects parent_id as a string. The
        // notification frame may carry numeric `id` (e.g. real-time WS) or a
        // string `id` (e.g. sync catch-up); normalize to avoid HTTP 422
        // "expected string, location body.parent_id".
        parent_id: String(msg.id),
      },
    );
  } catch (e) {
    warn(`[${orgConfig.slug}] reject notice for msg=${msg.id} failed: ${e.message}`);
  }
}

function forwardToC4(endpoint, body) {
  // c4-receive.js only accepts named flags (--channel / --endpoint / --content
  // / --json); the old positional invocation form
  // `node c4-receive.js <channel> <endpoint> <body>` now rejects with
  // "Unexpected argument: <channel>". execFile passes the array as argv
  // directly, so no shell-escape is needed for content.
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        C4_RECEIVE,
        '--channel', CHANNEL,
        '--endpoint', endpoint,
        '--json',
        '--content', body,
      ],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      },
    );
  });
}

// =============================================================================
// Receive acknowledgement — react to an inbound message on receipt
// =============================================================================
//
// cws-comm allows agent principals to add reactions as of PRD v2.5 (cws-comm
// MR !398; the prior human-only hard reject was removed). The reaction
// registry is deliberately kept at 8 keys — ⏳ (hourglass) is NOT registered —
// so the "received / processing" acknowledgement uses the closest registered
// code, `eyes` (👀). Overridable via config.message.receive_reaction_code
// (must be one of the registry keys: thumbs_up/smile/heart/tada/eyes/joy/
// fire/white_check_mark). Set to "" to disable. Fire-and-forget: a failed
// reaction must never delay or block delivering the message to the agent.
const DEFAULT_RECEIVE_REACTION = 'eyes';

function reactOnReceive(orgConfig, msg) {
  const code = config.message?.receive_reaction_code ?? DEFAULT_RECEIVE_REACTION;
  if (!code || !msg?.id) return;
  // POST /api/v1/messages/{message_id}/reactions {reaction_code} — proxied by
  // cws-core (transport/http/reaction.go) to cws-comm. Reactor identity (agent)
  // is derived server-side from the auth principal.
  postForOrg(orgConfig.org_id, apiPath(`/messages/${msg.id}/reactions`), { reaction_code: code })
    .then(() => log(`[${orgConfig.slug}] reacted '${code}' on msg=${msg.id}`))
    .catch(e => warn(`[${orgConfig.slug}] react-on-receive failed msg=${msg.id}: ${e.message}`));
}

// =============================================================================
// Mark conversation as read — advance the agent's read cursor
// =============================================================================
//
// POST /api/v1/conversations/{id}/read — tells cws-comm that the agent has
// consumed messages up to the current point. Without this, the agent's read
// cursor stays at 0 and cws-fe shows perpetual "unread" badges.
// Fire-and-forget (like reactOnReceive): a failed mark-read must never block
// message delivery or outbound sends.

function markRead(orgConfig, conversationId, seq) {
  if (!conversationId || !seq) return;
  postForOrg(orgConfig.org_id, apiPath(`/conversations/${conversationId}/read`), { read_until_seq: seq })
    .then(() => log(`[${orgConfig.slug}] marked read conv=${conversationId} seq=${seq}`))
    .catch(e => warn(`[${orgConfig.slug}] mark-read failed conv=${conversationId}: ${e.message}`));
}

// =============================================================================
// Policy filter — lark-style, applied per inbound message
// =============================================================================

function extractMentions(msg) {
  const raw =
       msg.mentions
    || msg.mention_user_ids
    || msg.content?.mention_user_ids
    || msg.message?.mentions
    || [];
  // Normalize to a list of ID strings. cws-comm shape is {entity_id, ...};
  // raw string IDs and {id} variants are supported as fallbacks.
  return raw.map(m =>
    typeof m === 'string'
      ? m
      : String(m?.entity_id || m?.mentioned_id || m?.id || '')
  ).filter(Boolean);
}

// Detect @<selfName> in the message text body. cws-core's get-message returns
// raw text with literal "@Name" rather than a structured mentions[] array, so
// without this fallback the mode=mention gate and the owner-mention bypass
// would never trigger in practice.
function isSelfNameMentionedInText(msg, selfName) {
  if (!selfName) return false;
  const text =
       msg.content?.body?.text
    || (typeof msg.content === 'string' ? msg.content : '')
    || (typeof msg.message?.content === 'string' ? msg.message.content : '')
    || msg.content_text
    || '';
  if (!text) return false;
  const escaped = selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `(?![\w-])` keeps "@Zylos" from matching "@Zylos-GavinBox" or "@ZylosX".
  return new RegExp('@' + escaped + '(?![\\w-])', 'i').test(text);
}

// User-facing notice strings shown when a message is rejected. Mirrors the
// English copy in zylos-feishu/src/index.js — group rejections only fire when
// the sender actually @-mentioned us, so a non-@-ed group message that hits a
// policy gate stays silent (no userNotice set). DM rejections always notify.
function noticeDmNotAllowed(ownerName) {
  if (ownerName) return `Sorry, I'm not available for private messages. Please contact ${ownerName} to grant you access.`;
  return "Sorry, I'm not available for private messages. Please ask my owner to grant you access.";
}
const NOTICE_GROUP_DISABLED =
  "Sorry, group chat is currently disabled.";
const NOTICE_GROUP_NOT_ALLOWED =
  "Sorry, I'm not available in this group.";
const NOTICE_GROUP_SENDER_NOT_ALLOWED =
  "Sorry, you don't have permission to interact with me in this group.";

/**
 * Apply DM / group access policy for a specific org. Returns:
 *   { handle: true, reason }   — message passes, agent should respond
 *   { handle: false, reason }  — message dropped (logged with reason)
 *   { handle: true, bindOwnerHint: {memberId, displayName} }
 *                              — pass + caller should auto-bind owner
 *
 * When a drop should be surfaced back to the sender as a polite refusal, the
 * decision additionally carries a `userNotice` string (mirrors
 * zylos-feishu replyToMessage / sendMessage rejection paths). Caller posts it
 * via the cws-core messages API; sync-replay frames are expected to skip the
 * notice to avoid spamming old conversations after a bug fix.
 */
function shouldHandleMessage(msg, conv, orgConfig) {
  const selfMemberId = orgConfig.self?.member_id;

  // Skip self-echo: agent's own messages within this org.
  if (msg.sender_id && selfMemberId && msg.sender_id === selfMemberId) {
    return { handle: false, reason: 'self-echo' };
  }

  const convType = (conv?.type || '').toLowerCase() || (msg.thread_id ? 'thread' : 'dm');
  const access = orgConfig.access || {};
  const senderId = msg.sender_id;
  const senderName = msg.sender_display_name || msg.sender?.display_name || '';

  if (convType === 'dm') {
    const policy = access.dmPolicy || 'owner';
    // Owner is always allowed in DM, regardless of policy (mirrors the group
    // branch's owner @-mention exemption below). Without this, dmPolicy=allowlist
    // silently drops the bound owner's DMs unless their member_id was also
    // manually added to dmAllowFrom — the bug recorded as KB "CWS Issue 汇总" #34.
    const dmOwnerMemberId = orgConfig.owner?.member_id;
    if (dmOwnerMemberId && String(senderId) === String(dmOwnerMemberId)) {
      if (!orgConfig.owner.name && senderName) {
        orgConfig.owner.name = senderName;
        updateOwnerName(orgConfig.slug, senderName);
      }
      return { handle: true, reason: 'dm:owner-exempt' };
    }
    if (policy === 'open') return { handle: true, reason: 'dm:open' };
    if (policy === 'allowlist') {
      const list = (access.dmAllowFrom || []).map(String);
      if (list.includes(String(senderId))) return { handle: true, reason: 'dm:allowlist' };
      const ownerName = orgConfig.owner?.name;
      return {
        handle: false,
        reason: `dm:allowlist (sender ${senderId} not listed)`,
        userNotice: noticeDmNotAllowed(ownerName),
      };
    }
    // policy === 'owner' — bound state is derived from owner.member_id
    const owner = orgConfig.owner || {};
    if (!owner.member_id) {
      // First DM ever for this org → auto-bind sender as owner and accept.
      return {
        handle: true,
        reason: 'dm:owner (auto-bind)',
        bindOwnerHint: { memberId: senderId, displayName: senderName },
      };
    }
    // A bound owner is already accepted by the owner-exempt check above; any
    // other sender under owner-policy is rejected.
    return {
      handle: false,
      reason: `dm:owner (sender ${senderId} != bound owner ${owner.member_id})`,
      userNotice: noticeDmNotAllowed(owner.name),
    };
  }

  // group / thread — compute mentioned/owner once up front so all gates and
  // their userNotice decisions share the same view.
  const policy = access.groupPolicy || 'allowlist';
  const convId = msg.conversation_id;
  const groupCfg = (access.groups || {})[convId];

  // Mention detection has two paths: structured mentions[] from cws-comm, and
  // a text-based "@<selfName>" fallback for messages where the server returns
  // the raw text without a structured mentions array.
  const mentions = extractMentions(msg).map(String);
  const mentionedById = !!selfMemberId && mentions.includes(String(selfMemberId));
  const mentionedByText = isSelfNameMentionedInText(msg, orgConfig.self?.name);
  const mentioned = mentionedById || mentionedByText;
  const ownerMemberId = orgConfig.owner?.member_id;
  const senderIsOwner = !!ownerMemberId && String(senderId) === String(ownerMemberId);

  if (policy === 'disabled') {
    return {
      handle: false,
      reason: 'group:disabled',
      userNotice: mentioned ? NOTICE_GROUP_DISABLED : undefined,
    };
  }

  // Owner @-mention bypasses the allowlist gate (mirrors zylos-feishu 1242).
  if (policy === 'allowlist' && !groupCfg && !(senderIsOwner && mentioned)) {
    return {
      handle: false,
      reason: `group:allowlist (${convId} not in groups{})`,
      userNotice: mentioned ? NOTICE_GROUP_NOT_ALLOWED : undefined,
    };
  }

  // mode: per-group `mode` if present, else default to 'mention'
  const mode = groupCfg?.mode || 'mention';
  if (mode === 'mention' && !mentioned) {
    // No userNotice — this is normal background traffic, replying would spam.
    return { handle: false, reason: 'group:mention (not @-ed)' };
  }
  // mode === 'smart' bypasses the mention requirement

  // allowFrom: ['*'] / [] = all members allowed; otherwise restrict.
  // Owner is exempt from per-group allowFrom — matches zylos-feishu.
  const allowFrom = groupCfg?.allowFrom;
  if (allowFrom && allowFrom.length > 0 && !allowFrom.includes('*') && !senderIsOwner) {
    if (!allowFrom.map(String).includes(String(senderId))) {
      return {
        handle: false,
        reason: `group:allowFrom (sender ${senderId} not allowed in ${convId})`,
        userNotice: mentioned ? NOTICE_GROUP_SENDER_NOT_ALLOWED : undefined,
      };
    }
  }

  const ownerTag = (!groupCfg && senderIsOwner && mentioned) ? ' [owner-mention-bypass]' : '';
  return {
    handle: true,
    reason: `group:${policy}/${mode}${ownerTag}`,
    mode,
    mentioned,
    groupCfg,
  };
}

// =============================================================================
// Per-org inbound message handler
// =============================================================================

function makeOrgMessageHandler(orgConfig, sessionRef) {
  return async function handleIncomingMessage(payload) {
    const notification = payload?.payload || payload;
    const notifId = notification?.id;
    const notifConv = notification?.conversation_id;
    const notifSender = notification?.sender_id;
    log(`[ws] [${orgConfig.slug}] message frame: id=${notifId || '<missing>'} conv=${notifConv || '<missing>'} sender=${notifSender || '?'}`);
    if (!notifId || !notifConv) return;
    if (dedupe(notifId)) {
      log(`[ws] [${orgConfig.slug}] msg=${notifId} duplicate, skipping`);
      return;
    }

    const detail = await fetchMessageDetail(orgConfig.org_id, notification.conversation_id, notification.id);
    const msg = { ...notification, ...(detail || {}) };
    cacheMessageText(notification.id, msg.content?.body?.text);
    // get-message envelope nests scalar message fields under `message`; for
    // real-time WS frames the notification already carries sender_id/seq/type
    // at the top level, but sync catch-up frames don't. Hoist them so
    // downstream consumers (shouldHandleMessage, last_seq update, msgType
    // detection) see a uniform shape regardless of arrival path.
    if (!msg.sender_id   && msg.message?.sender_id)   msg.sender_id   = msg.message.sender_id;
    if (msg.seq == null  && msg.message?.seq != null) msg.seq         = msg.message.seq;
    if (!msg.type        && msg.message?.type)        msg.type        = msg.message.type;
    if (!msg.thread_id   && msg.message?.thread_id)   msg.thread_id   = msg.message.thread_id;
    if (!msg.parent_message_id && msg.message?.parent_message_id) {
      msg.parent_message_id = msg.message.parent_message_id;
    }

    // NOTE: a global seq-floor gate was tried in 1.0.10 and REVERTED here —
    // `seq` is per-conversation, not a per-org monotonic cursor, so gating on a
    // single org-wide last_seq dropped live messages from any conversation whose
    // seq sat below the global max (caused a message-delivery outage). Duplicate
    // suppression relies on the id-based deduper only (which IS persisted across
    // restarts via dedup.json — that part is safe). last_seq is still advanced
    // below purely as the catch-up cursor.

    const conv = await fetchConversation(orgConfig.org_id, msg.conversation_id);
    if (conv) conv.id = conv.id || msg.conversation_id;

    const decision = shouldHandleMessage(msg, conv || {}, orgConfig);
    if (!decision.handle) {
      log(`drop [${orgConfig.slug}] msg=${msg.id}: ${decision.reason}`);
      // Send a polite refusal only when it actually helps the sender. Two
      // skips:
      //   - sync-replay frames re-process historic messages; a notice for
      //     each would spam stale apologies after a bug fix.
      //   - other agents (sender_type=AGENT) can DM us in normal workflows
      //     (e.g. cws-comm agent-to-agent). They don't read English copy
      //     and could auto-respond, producing reject-notice ping-pong.
      const senderType = String(msg.sender_type || msg.message?.sender_type || '').toUpperCase();
      const isSyncReplay = notification._via === 'sync';
      const isAgentSender = senderType === 'AGENT';
      if (decision.userNotice && !isSyncReplay && !isAgentSender) {
        sendRejectNotice(orgConfig, msg, decision.userNotice).catch(() => {});
      }
      return;
    }

    // Feature 1 (chat-features): acknowledge receipt by reacting to the inbound
    // message immediately (fire-and-forget, only for messages we actually
    // handle). See reactOnReceive — ⏳ is not registry-supported, so 👀 is used.
    reactOnReceive(orgConfig, msg);

    if (decision.bindOwnerHint) {
      // Fallback binding only: shouldHandleMessage emits bindOwnerHint solely
      // when no owner is bound, and the WS open-time syncOwnerFromCore has
      // already authoritatively applied any owner cws-core knows about. So we
      // only reach here when core ALSO has no owner — first-DM auto-bind then
      // takes over locally (bindOwner no-ops if a binding sneaked in meanwhile).
      const { memberId, displayName } = decision.bindOwnerHint;
      log(`bind owner (fallback, core had none) [${orgConfig.slug}] member_id=${memberId} name="${displayName}"`);
      bindOwner(orgConfig.slug, memberId, displayName);
      // Mutate the captured orgConfig so subsequent decisions see the new owner.
      orgConfig.owner = { member_id: memberId, name: displayName || '' };
    }

    if (msg.seq && msg.seq > (sessionRef.last_seq || 0)) {
      sessionRef.last_seq = msg.seq;
      saveOrgSession(orgConfig.slug, { org_id: orgConfig.org_id, last_seq: msg.seq });
    }

    let recent = [];
    const convType = (conv?.type || '').toLowerCase() || (msg.thread_id ? 'thread' : 'dm');
    if (convType !== 'dm') {
      const ctx = await fetchRecentMessages(
        orgConfig.org_id,
        msg.conversation_id,
        msg.seq,
        config.message?.context_messages ?? DEFAULT_CONTEXT_MESSAGES,
      );
      // cws-comm list-messages with before_seq returns DESC (newest→oldest);
      // sort ascending by seq so <group-context> reads chronologically
      // (oldest→newest).
      const ctxAsc = [...ctx].sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      recent = await Promise.all(ctxAsc.map(async m => ({
        // Resolve the sender's display name; fall back to the raw id only when
        // cws-core gives us neither an inline name nor a resolvable member.
        senderName: m.sender_display_name
                 || m.senderName
                 || (await fetchMemberName(orgConfig.org_id, m.sender_id))
                 || m.sender_id,
        // list-messages returns a flat string in `m.content` (the canonical
        // top-level fallback_text); get-message instead returns a structured
        // object at `m.content.body.text`. Cover both for forward-compat.
        content:    m.content?.body?.text
                 || (typeof m.content === 'string' ? m.content : '')
                 || m.content_text
                 || '',
      })));
    }

    // After `msg = { ...notification, ...detail }`, where detail is the
    // get-message response unwrapped from D8 envelope:
    //   msg.message  → { id, content: <string>, type, sender_id, seq, ... }
    //   msg.content  → { content_type, body: { text, ... }, attachments: [] }
    // Older bridge code assumed msg.content was a flat object with `.text`
    // and `.media_id`, which silently produced empty content under the
    // current cws-core schema.
    const structured = (msg.content && typeof msg.content === 'object') ? msg.content : {};
    const text =
        structured.body?.text
     || (typeof msg.message?.content === 'string' ? msg.message.content : '')
     || (typeof msg.content === 'string' ? msg.content : '')
     || '';

    let mediaLocalPath;
    const firstAttachment = Array.isArray(structured.attachments) ? structured.attachments[0] : null;
    // attachment shape per cws-core: {artifact_id, file_name, content_type, size_bytes}
    const mediaId = firstAttachment?.artifact_id || structured.media_id; // structured.media_id kept as legacy fallback
    const mediaFileName = firstAttachment?.file_name || structured.filename;
    if (mediaId) {
      try {
        const { url } = await getMediaUrl(mediaId, orgConfig.org_id);
        if (url) mediaLocalPath = await downloadMedia(url, mediaFileName || mediaId);
      } catch (e) {
        warn('media fetch failed:', e.message);
      }
    }

    // Prefer an inline display name from the message; otherwise resolve the
    // sender member via cws-core (cached). Fall back to the raw id only when
    // no name is available — keeps the C4 envelope legible (issue #2).
    const senderName = msg.sender_display_name
                    || msg.sender?.display_name
                    || (await fetchMemberName(orgConfig.org_id, msg.sender_id))
                    || msg.sender_id;
    const msgType = (msg.type || msg.message?.type || '').toLowerCase();
    const endpoint = formatEndpoint({
      type: convType,
      conversationId: msg.conversation_id,
      threadConversationId: msg.thread_id || undefined,
      parentMessageId: msg.thread_id ? msg.parent_message_id : undefined,
    });
    // smartHint mirrors zylos-feishu: only emitted when the group is in smart
    // mode AND the bot was NOT @-mentioned. When the bot was directly @-ed we
    // want a direct reply, not a "should I respond?" deliberation.
    const smartHint = decision.mode === 'smart' && !decision.mentioned;
    const groupName = decision.groupCfg?.name || conv?.name;

    // Record the display names seen in this conversation (sender + group
    // context) so outbound @mentions can be canonicalized to the exact name
    // cws-fe matches on. Best-effort; never blocks message handling.
    recordParticipants(msg.conversation_id, [senderName, ...recent.map((m) => m.senderName)]);

    // Quoted/reply: cws-comm marks a reply with parent_id (the WS notification
    // frame omits it, so it comes from the get-message detail merged into msg).
    // Fetch the quoted message and surface it as <replying-to>. Threads take
    // precedence (threadContext), so skip for threads.
    let quotedContent;
    const quotedMsgId = msg.parent_id || msg.message?.parent_id || msg.parent_message_id;
    if (quotedMsgId && convType !== 'thread') {
      const q = await fetchMessageDetail(orgConfig.org_id, msg.conversation_id, quotedMsgId);
      if (q) {
        const qStructured = (q.content && typeof q.content === 'object') ? q.content : {};
        let qText =
             qStructured.body?.text
          || (typeof q.message?.content === 'string' ? q.message.content : '')
          || q.message?.fallback_text
          || '';
        // Quoted media: a quoted image/file with no caption yields empty text,
        // which would drop the whole quote. Label it ([image]/[file: name]) and
        // download the referenced attachment, appending `---- <kind>: <path>` so
        // the agent can actually READ the quoted media (not just know it exists).
        const qType = (q.message?.type || '').toLowerCase();
        const qIsImage = qType === 'image' || qType === 'agent_card';
        const qAtt = Array.isArray(qStructured.attachments) ? qStructured.attachments[0] : null;
        const qMediaId = qAtt?.artifact_id || qStructured.media_id;
        if (!qText && (qIsImage || qMediaId)) {
          qText = qIsImage ? '[image]' : `[file${qAtt?.file_name ? ': ' + qAtt.file_name : ''}]`;
        }
        if (qMediaId) {
          try {
            const { url } = await getMediaUrl(qMediaId, orgConfig.org_id);
            if (url) {
              const qPath = await downloadMedia(url, qAtt?.file_name || qMediaId);
              if (qPath) qText += ` ---- ${qIsImage ? 'image' : 'file'}: ${qPath}`;
            }
          } catch (e) {
            warn('quoted media fetch failed:', e.message);
          }
        }
        const qSenderId = q.message?.sender_id;
        const qSender =
             q.message?.sender_display_name
          || (await fetchMemberName(orgConfig.org_id, qSenderId))
          || qSenderId;
        if (qText) quotedContent = { sender: qSender, text: qText };
      }
    }

    // Build a human-readable media label for the message body so an image/file
    // message isn't delivered as an empty `said:`. Mirrors other C4 channels:
    // the body carries `[image]` / `[file: name]` (plus any caption), while the
    // `---- <kind>: <path>` suffix (emitted by formatInboundForC4) still gives
    // the agent the local path when it needs to process the media.
    const isImage = msgType === 'image' || msgType === 'agent_card';
    const isFile = !isImage && !!mediaId;
    let displayContent = text;
    if (isImage) {
      displayContent = `[image]${text ? ' ' + text : ''}`;
    } else if (isFile) {
      displayContent = `[file${mediaFileName ? ': ' + mediaFileName : ''}]${text ? ' ' + text : ''}`;
    }

    const body = formatInboundForC4(
      { type: convType, id: msg.conversation_id, name: groupName },
      { displayName: senderName },
      {
        content: displayContent,
        type: isImage ? 'image' : (isFile ? 'file' : 'text'),
        mediaLocalPath,
      },
      recent,
      { groupName, smartHint, quotedContent, enforceSkillFlow: config.message?.enforceSkillFlow ?? true },
    );

    try {
      await forwardToC4(endpoint, body);
      log(`fwd [${orgConfig.slug}] ${convType} ${msg.conversation_id} msg=${msg.id} seq=${msg.seq}`);
      markRead(orgConfig, msg.conversation_id, msg.seq);
    } catch (e) {
      warn('c4-receive failed:', e.message);
    }
  };
}

// =============================================================================
// Per-org WS frame dispatch
// =============================================================================

const _frameTypeCounts = Object.create(null);
const WS_METRIC_INTERVAL_MS = 5 * 60 * 1000;
let _frameMetricTimer = null;

function recordFrameType(slug, type) {
  const k = `${slug}/${type || '(missing-type)'}`;
  _frameTypeCounts[k] = (_frameTypeCounts[k] || 0) + 1;
}

function dumpFrameMetrics() {
  const entries = Object.entries(_frameTypeCounts);
  if (entries.length === 0) {
    log('ws frame metric: no frames received in this window');
    return;
  }
  entries.sort((a, b) => b[1] - a[1]);
  log(`ws frame metric (cumulative since boot): ${entries.map(([k, n]) => `${k}=${n}`).join(' ')}`);
}

function startFrameMetricTimer() {
  if (_frameMetricTimer) return;
  _frameMetricTimer = setInterval(dumpFrameMetrics, WS_METRIC_INTERVAL_MS);
  _frameMetricTimer.unref?.();
}

// =============================================================================
// System events — message recall / edit → inject a notice to the agent
// =============================================================================
//
// cws-comm delivers non-create message lifecycle events (recalled / edited /
// deleted / reaction) as `system` frames — see cws-comm
// internal/transport/ws/gateway_consumer.go buildWSFrame(): "message.created"
// becomes a `message` frame, every other event becomes a `system` frame whose
// payload is { event, conversation_id, data }, where `data` is the raw event
// JSON (message_id, edited_by / deleted_by, new content, ...). We surface
// recall and edit to the agent as a synthetic inbound notice so it knows a
// prior message changed; reactions / read-state / other system events are
// logged and ignored (unchanged behavior).

// Event-name strings are cws-comm's authoritative domain event constants
// (cws-comm internal/domain/message_events.go, *.EventName()):
//   "message.recalled" / "message.deleted" -> recall
//   "message.updated"                       -> edit  (NB: cws-comm names edit
//                                              "updated", not "edited")
// Ignored (return null): message.created / .read / .delivered /
//   .reaction.added / .reaction.removed / .mention.created.
// Exact match keeps us in lock-step with the contract; the substring fallback
// only guards against a future rename (e.g. a "message.edited" alias).
function classifySystemEvent(eventName) {
  const e = String(eventName || '').toLowerCase();
  if (e === 'message.recalled' || e === 'message.deleted') return 'recall';
  if (e === 'message.updated') return 'edit';
  // Defensive fallback for naming drift — does not match reaction/read/etc.
  if (e.includes('recall') || e.includes('delete')) return 'recall';
  if (e.includes('edit') || e.includes('updat')) return 'edit';
  return null;
}

async function handleSystemEvent(orgConfig, frame) {
  const payload = frame.payload || {};
  const kind = classifySystemEvent(payload.event);
  if (!kind) {
    warn(`[${orgConfig.slug}] unhandled system event: ${payload.event || '(unknown)'} conv=${payload.conversation_id || '?'}`);
    return;
  }

  const data = payload.data || {};
  const conversationId = payload.conversation_id || data.conversation_id;
  if (!conversationId) {
    warn(`[${orgConfig.slug}] system ${payload.event}: missing conversation_id, skip`);
    return;
  }
  const messageId = data.message_id || data.id || data.msg_id || '';

  // Dedup so a reconnect/catch-up replay of the same lifecycle event does not
  // re-inject the notice. Keyed distinctly from message-create ids.
  const dedupKey = `sys:${kind}:${conversationId}:${messageId || payload.event}`;
  if (dedupe(dedupKey)) {
    log(`[${orgConfig.slug}] system ${kind} dedup msg=${messageId}`);
    return;
  }

  const orgId = orgConfig.org_id;
  const actorId = data.recalled_by || data.edited_by || data.sender_id || '';
  const actorName = (await fetchMemberName(orgId, actorId)) || actorId || '对方';

  let notice;
  if (kind === 'recall') {
    let originalText = messageId ? getCachedMessageText(messageId) : '';
    if (!originalText && messageId) {
      const detail = await fetchMessageDetail(orgId, conversationId, messageId);
      originalText = detail?.content?.body?.text || '';
    }
    notice = originalText
      ? `[Message Recalled] Do not act on it. (Original: ${originalText})`
      : `[Message Recalled] A message was recalled. Do not act on it.`;
  } else {
    // Edit: fetch the updated message to get the new full content.
    let newText = '';
    if (messageId) {
      const detail = await fetchMessageDetail(orgId, conversationId, messageId);
      newText = detail?.content?.body?.text || '';
    }
    if (!newText) {
      newText = (typeof data?.content?.body?.text === 'string' && data.content.body.text)
        || (typeof data.new_content === 'string' && data.new_content)
        || (typeof data.text === 'string' && data.text)
        || '';
    }
    notice = newText
      ? `[Message Edited] ${newText}`
      : `[Message Edited] A message was edited. Use the latest content.`;
  }

  // Inject as a standalone inbound notice (no skill-flow directive — this is a
  // system event, not a user task). conv type defaults to dm; the endpoint is
  // keyed by conversationId so routing is correct regardless of dm/group.
  const endpoint = formatEndpoint({ type: 'dm', conversationId });
  const body = formatInboundForC4(
    { type: 'dm', id: conversationId },
    { displayName: actorName },
    { content: notice, type: 'text' },
    [],
    { enforceSkillFlow: false },
  );
  try {
    await forwardToC4(endpoint, body);
    log(`[${orgConfig.slug}] system ${kind} notice -> agent conv=${conversationId} msg=${messageId}`);
  } catch (e) {
    warn(`[${orgConfig.slug}] system ${kind} notice failed: ${e.message}`);
  }
}

function makeOrgFrameDispatcher(orgConfig, onMessage) {
  return function onFrame(frame) {
    const type = frame.type;
    recordFrameType(orgConfig.slug, type);
    switch (type) {
      case 'message':
        onMessage(frame).catch(e => warn(`[${orgConfig.slug}] handleIncomingMessage:`, e.message));
        break;
      case 'message_ack':
        log(`[${orgConfig.slug}] message_ack seq=${frame.payload?.seq} msg=${frame.payload?.message_id}`);
        break;
      case 'system':
        log(`[${orgConfig.slug}] system event=${frame.payload?.event || '<unknown>'} conv=${frame.payload?.conversation_id || '<unknown>'}`);
        handleSystemEvent(orgConfig, frame).catch(e => warn(`[${orgConfig.slug}] handleSystemEvent:`, e.message));
        break;
      case 'error':
        warn(`[${orgConfig.slug}] server error frame:`, JSON.stringify(frame.payload || {}));
        break;
      case 'typing':
      case 'presence':
      case 'read_receipt':
      case 'read_state_update':
        break;
      default:
        log(`[${orgConfig.slug}] unknown frame type:`, type);
    }
  };
}

// =============================================================================
// Disconnect catch-up — pull missed events via POST /api/v1/sync
// =============================================================================

// Cap a single catch-up sweep to avoid pulling unbounded backlog after a
// very long outage. If there are more than this many events to catch up,
// the rest will be pulled on the next reconnect (or the operator can
// manually invoke `comm.sync` from the CLI).
const SYNC_PAGE_SIZE  = 100;
const SYNC_MAX_EVENTS = 2000;

// Per-org guard so a concurrent reconnect doesn't trigger overlapping syncs.
const _syncInFlight = new Set();

async function syncMissedEvents(orgConfig, sessionRef, onMessage) {
  if (!sessionRef.last_seq) return;  // first-ever connect → nothing to catch up
  if (_syncInFlight.has(orgConfig.slug)) {
    log(`[${orgConfig.slug}] sync already in flight, skipping`);
    return;
  }
  _syncInFlight.add(orgConfig.slug);
  try {
    const startSeq = sessionRef.last_seq;
    let sinceSeq = startSeq;
    let totalSynced = 0;
    let hasMore = true;

    while (hasMore && totalSynced < SYNC_MAX_EVENTS) {
      const res = await postForOrg(orgConfig.org_id, apiPath('/sync'), {
        since_seq: sinceSeq,
        device_id: config.agent?.device_id || '',
        limit:     SYNC_PAGE_SIZE,
      });
      const events = Array.isArray(res?.events) ? res.events : [];
      hasMore = res?.has_more === true;
      if (events.length === 0) break;

      for (const ev of events) {
        if (!ev?.message_id || !ev.conversation_id) continue;
        await onMessage({
          id:              String(ev.message_id),
          conversation_id: ev.conversation_id,
          seq:             ev.seq,
          // mark synthetic so it's clear in logs which path produced it
          _via:            'sync',
        });
        if (typeof ev.seq === 'number' && ev.seq > sinceSeq) sinceSeq = ev.seq;
      }
      totalSynced += events.length;
    }

    if (totalSynced > 0) {
      log(`[${orgConfig.slug}] sync caught up ${totalSynced} event(s) since seq=${startSeq}` +
          (hasMore && totalSynced >= SYNC_MAX_EVENTS ? ` (hit per-sweep cap, more on next reconnect)` : ''));
    }
  } catch (err) {
    warn(`[${orgConfig.slug}] sync failed: ${err.message} — will retry on next reconnect`);
  } finally {
    _syncInFlight.delete(orgConfig.slug);
  }
}

// =============================================================================
// Owner sync — cws-core is the authoritative source of an agent's owner
// =============================================================================
//
// An agent's owner can be reassigned server-side via cws-core
// (POST /api/v1/platform-agents/{member_id}/transfer-owner). cws-core holds the
// authoritative `owner_member_id`; this plugin's `orgs.<slug>.owner` block is a
// local cache. On every WS (re)connect we pull our own member record and, when
// core reports a different owner, update both the live in-memory orgConfig and
// config.json — no restart needed.
//
// Pull-based by design: we never let a pushed WS payload mutate ownership (a
// forged frame must not be able to hand the bot to an attacker). The
// authoritative read is an authenticated GET against core.
//
// Sync triggers: (1) every WS (re)connect, (2) every OWNER_SYNC_INTERVAL_MS
// while the process is alive (covers long-lived connections). CLI
// `comm.sync_owner` provides a manual trigger.
//
// The first-DM auto-bind (bindOwner) is only a fallback for when core has NO
// owner recorded — if core reports an owner here it always wins, and when core
// reports none we leave the local binding untouched so auto-bind still works.

async function syncOwnerFromCore(orgConfig) {
  const selfMemberId = orgConfig.self?.member_id;
  if (!selfMemberId) {
    // member_id is written back by the token exchange; if it's not there yet
    // we simply skip this round and try again on the next reconnect.
    return;
  }
  let member;
  try {
    member = await getForOrg(orgConfig.org_id, apiPath(`/members/${selfMemberId}`));
  } catch (err) {
    warn(`[${orgConfig.slug}] owner-sync: fetch self member failed: ${err.message} — keeping local owner`);
    return;
  }
  const coreOwnerId = member?.owner_member_id || '';
  // Core has no authoritative owner → leave the local binding as-is so the
  // first-DM auto-bind fallback keeps working. We never clear a local owner here.
  if (!coreOwnerId) return;

  const localOwnerId = orgConfig.owner?.member_id || '';
  if (coreOwnerId === localOwnerId) return; // already in sync

  let ownerName = '';
  try { ownerName = (await fetchMemberName(orgConfig.org_id, coreOwnerId)) || ''; }
  catch { /* display name is cosmetic */ }

  // Persist to config.json and update the live captured orgConfig in place so
  // the message handler's owner gate sees the new owner without a restart.
  setOwner(orgConfig.slug, coreOwnerId, ownerName);
  orgConfig.owner = { member_id: coreOwnerId, name: ownerName };
  const live = activeOrgConfigs.get(orgConfig.slug);
  if (live && live !== orgConfig) live.owner = { member_id: coreOwnerId, name: ownerName };
  log(`[${orgConfig.slug}] owner synced from core: ${localOwnerId || '(none)'} → ${coreOwnerId}${ownerName ? ` (${ownerName})` : ''}`);

  // Notify the bot session so it can update memory/references.md with the new
  // owner — config.json is updated but the AI context won't see it until told.
  notifyOwnerChanged(orgConfig.slug, coreOwnerId, ownerName, localOwnerId);
}

function notifyOwnerChanged(orgSlug, newOwnerId, newOwnerName, previousOwnerId) {
  const payload = JSON.stringify({
    type: 'owner-changed',
    org: orgSlug,
    owner: { member_id: newOwnerId, name: newOwnerName },
    previous_owner_member_id: previousOwnerId || null,
  });
  const content = `[OWNER-CHANGED] ${payload}`;
  execFile(
    process.execPath,
    [C4_CONTROL, 'enqueue', '--content', content, '--priority', '2', '--no-ack-suffix'],
    { timeout: 10000 },
    (err, _stdout, stderr) => {
      if (err) warn(`[${orgSlug}] failed to enqueue owner-changed control: ${stderr || err.message}`);
      else log(`[${orgSlug}] owner-changed control enqueued`);
    },
  );
}

// Periodic owner sync — covers the gap where a WS connection stays alive but
// the owner was reassigned on cws-core. Interval is conservative (5 min);
// each round is one cheap GET per org.
const OWNER_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let _ownerSyncTimer = null;

function startPeriodicOwnerSync() {
  if (_ownerSyncTimer) return;
  _ownerSyncTimer = setInterval(() => {
    for (const [slug, orgConfig] of activeOrgConfigs) {
      syncOwnerFromCore(orgConfig).catch(e =>
        warn(`[${slug}] periodic owner-sync failed: ${e.message}`));
    }
  }, OWNER_SYNC_INTERVAL_MS);
  _ownerSyncTimer.unref?.();
}

// =============================================================================
// WS pool — one connection per enabled org
// =============================================================================

const wsClients = [];
let liveOrgCount = 0;

// Live per-org config snapshots. `makeOrgMessageHandler` captures the
// orgConfig at boot, so shouldHandleMessage / sendRejectNotice all read
// through this same object. Hot-reload mutates it in place (see the
// watchConfig callback at the bottom) so policy edits like adding a group to
// `access.groups` take effect without a service restart.
const activeOrgConfigs = new Map(); // slug → orgConfig (mutable)

async function bootstrapOrgToken(orgConfig) {
  // Mint a JWT eagerly so token.exchange's member_id write-back lands before
  // the first WS open (and thus before the first inbound message hits the
  // self-echo / @-mention filter). Errors here are non-fatal — the WS
  // urlProvider will retry through its own backoff loop.
  log(`[bootstrap] org=${orgConfig.slug} (${orgConfig.org_id}) acquiring JWT…`);
  try {
    await getAccessToken(orgConfig.org_id);
    log(`[bootstrap] org=${orgConfig.slug} JWT ready`);
  } catch (err) {
    warn(`[bootstrap] org=${orgConfig.slug} JWT acquire failed: ${err.message} — WS will retry`);
  }
}

function startOrgWs(orgConfig, wsBaseUrl) {
  const session = loadOrgSession(orgConfig.slug) || {};
  const sessionRef = { last_seq: session.last_seq || 0 };
  if (sessionRef.last_seq) {
    log(`[${orgConfig.slug}] warm-restart: lastSeq=${sessionRef.last_seq}`);
  }

  const onMessage = makeOrgMessageHandler(orgConfig, sessionRef);
  const onFrame = makeOrgFrameDispatcher(orgConfig, onMessage);

  const ws = new WsClient({
    urlProvider: async () => {
      log(`[ticket] org=${orgConfig.slug} requesting ws-ticket`);
      const ticket = await getWsTicket(orgConfig.org_id);
      log(`[ticket] org=${orgConfig.slug} got ws-ticket, connecting…`);
      return `${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`;
    },
    deviceId:            config.agent?.device_id,
    clientVersion:       config.agent?.app_version,
    reconnectMaxMs:      config.server?.reconnect_max_delay ?? DEFAULT_WS_RECONNECT_MAX_MS,
    heartbeatIntervalMs: config.server?.heartbeat_interval  ?? DEFAULT_WS_HEARTBEAT_MS,

    onOpen: async () => {
      log(`[ws] org=${orgConfig.slug} open (org_id=${orgConfig.org_id})`);
      // Pull the authoritative owner from cws-core first (one cheap GET) so the
      // owner gate is current before we replay any caught-up messages — e.g. a
      // newly-transferred owner's queued DM must not be rejected. Errors are
      // swallowed inside syncOwnerFromCore and never tear down the connection.
      await syncOwnerFromCore(orgConfig);
      // Then pull anything missed since the last persisted seq. No-op on
      // first-ever connect (last_seq=0). Errors are caught inside
      // syncMissedEvents — they don't tear down the connection.
      syncMissedEvents(orgConfig, sessionRef, onMessage);
    },

    onMessage: onFrame,

    onClose: (code, reason, willReconnect) => {
      log(`[${orgConfig.slug}] closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
      if (code === 4003) {
        // Session expired: drop the cached JWT/ticket so urlProvider mints a
        // fresh one on the next connect. Keep `last_seq` — the conversation
        // sequence is independent of the WS session, and we need it so the
        // post-reconnect sync sweep can catch up.
        log(`[${orgConfig.slug}] session expired; invalidating token cache (last_seq preserved for sync)`);
        invalidateToken(orgConfig.org_id);
      }
    },

    onFatal: (code, reason) => {
      console.error(LOG_PREFIX, `[${orgConfig.slug}] FATAL close code=${code} reason="${reason || ''}" — stopping this org`);
      if (code === 4002) console.error(LOG_PREFIX, `[${orgConfig.slug}] → auth failed; check api_key / org_id`);
      if (code === 4005) console.error(LOG_PREFIX, `[${orgConfig.slug}] → workspace suspended`);
      if (code === 4006) console.error(LOG_PREFIX, `[${orgConfig.slug}] → duplicate connection`);
      liveOrgCount -= 1;
      if (liveOrgCount <= 0) {
        console.error(LOG_PREFIX, 'all orgs terminated — exiting');
        process.exit(1);
      }
    },
  });

  wsClients.push({ slug: orgConfig.slug, ws });
  activeOrgConfigs.set(orgConfig.slug, orgConfig);
  liveOrgCount += 1;
  ws.start();
  log(`[${orgConfig.slug}] started (org=${orgConfig.org_id})`);
}

// =============================================================================
// Main
// =============================================================================

if (!config.enabled) {
  log('disabled in config, exiting');
  process.exit(0);
}

const wsUrl = process.env.COCO_WS_URL || config.server?.ws_url;
if (!wsUrl) {
  console.error(LOG_PREFIX, 'COCO_WS_URL / config.server.ws_url not set');
  process.exit(1);
}
const wsBaseUrl = wsUrl.replace(/\?.*$/, '');

if (!config.agent?.api_key) {
  warn('no config.agent.api_key — token exchange will fail for every org');
}

const orgs = enabledOrgs();
if (orgs.length === 0) {
  warn('no enabled orgs in config.orgs — add at least one org block and restart.');
  warn('See ~/zylos/components/coco-workspace/config.json (post-install / post-upgrade printed the format).');
  // Stay alive so PM2 doesn't crash-loop the service; operator just needs to
  // edit config.json and restart.
  setInterval(() => {}, 1 << 30).unref?.();
} else {
  log(`booting WS pool: ${orgs.length} org(s) enabled`);
  // Pre-mint each org's JWT in parallel so member_id write-back happens
  // before the WS handler hits the first message. Each WS still has its own
  // urlProvider retry loop, so a failed bootstrap doesn't prevent startup.
  (async () => {
    await Promise.allSettled(orgs.map(bootstrapOrgToken));
    for (const orgConfig of orgs) {
      startOrgWs(orgConfig, wsBaseUrl);
    }
  })();
}

watchConfig((next) => {
  config = next;
  // Mutate captured per-org config objects in place so edits picked up by
  // watchConfig take effect without restarting the service: access policy
  // (`access.dmPolicy`, `access.groupPolicy`, `access.groups`,
  // `access.dmAllowFrom`) and `owner` (rebinding ownership). self / org_id /
  // api_key are still considered structural — adding or removing an org or
  // rotating the api_key still requires a service restart (logged below).
  let accessUpdates = 0;
  let ownerUpdates = 0;
  for (const [slug, live] of activeOrgConfigs) {
    const updated = next.orgs?.[slug];
    if (updated?.access) {
      live.access = updated.access;
      accessUpdates += 1;
    }
    // Owner edits (via `comm set-owner` / `comm sync-owner`, or the daemon's
    // own core owner-sync writing config.json) apply in place — no restart
    // needed to rebind ownership. org_id / api_key / self stay structural.
    if (updated?.owner && (updated.owner.member_id || '') !== (live.owner?.member_id || '')) {
      live.owner = { member_id: updated.owner.member_id || '', name: updated.owner.name || '' };
      ownerUpdates += 1;
    }
  }
  log(
    `config reloaded — applied access updates to ${accessUpdates} org(s), ` +
    `owner updates to ${ownerUpdates} org(s); ` +
    `WS settings apply on next reconnect; org_id/api_key/self changes require service restart`,
  );
});

process.on('SIGTERM', () => {
  log('SIGTERM, stopping all orgs');
  for (const c of wsClients) { try { c.ws.stop(); } catch {} }
  process.exit(0);
});
process.on('SIGINT', () => {
  log('SIGINT, stopping all orgs');
  for (const c of wsClients) { try { c.ws.stop(); } catch {} }
  process.exit(0);
});

startFrameMetricTimer();
startPeriodicOwnerSync();
