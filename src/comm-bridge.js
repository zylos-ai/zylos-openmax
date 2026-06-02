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

import { loadConfig, watchConfig, enabledOrgs, bindOwner } from './lib/config.js';
import { WsClient, createDeduper } from './lib/ws.js';
import { formatInboundForC4, formatEndpoint } from './lib/message.js';
import { getMediaUrl, downloadMedia } from './cli/as.js';
import { get, apiPath } from './lib/client.js';
import { getWsTicket, invalidate as invalidateToken } from './lib/token.js';
import { loadOrgSession, saveOrgSession, clearOrgSession } from './lib/session.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'coco-workspace';

const C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js',
);

function log(...a)  { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }

let config = loadConfig();
const dedupe = createDeduper(config.message?.dedup_ttl || 300000);

// org_id → cached Conversation row (response_mode no longer used for filter
// but other fields like `type` are still useful)
const conversationCache = new Map();

// =============================================================================
// REST helpers
// =============================================================================

async function fetchConversation(conversationId) {
  if (conversationCache.has(conversationId)) return conversationCache.get(conversationId);
  try {
    const conv = await get(apiPath(`/conversations/${conversationId}`));
    conversationCache.set(conversationId, conv);
    return conv;
  } catch (e) {
    warn(`fetchConversation ${conversationId} failed:`, e.message);
    return null;
  }
}

async function fetchRecentMessages(conversationId, beforeSeq, limit) {
  try {
    const r = await get(apiPath(`/conversations/${conversationId}/messages`), {
      before_seq: beforeSeq,
      limit:      limit || 10,
    });
    return Array.isArray(r) ? r : (r?.data || r?.messages || r?.items || []);
  } catch (e) {
    warn('fetchRecentMessages failed:', e.message);
    return [];
  }
}

async function fetchMessageDetail(conversationId, messageId) {
  try {
    return await get(apiPath(`/conversations/${conversationId}/messages/${messageId}`));
  } catch (e) {
    warn(`fetchMessageDetail conv=${conversationId} msg=${messageId} failed:`, e.message);
    return null;
  }
}

function forwardToC4(endpoint, body) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [C4_RECEIVE, CHANNEL, endpoint, body],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr || err.message));
        else resolve(stdout);
      },
    );
  });
}

// =============================================================================
// Policy filter — lark-style, applied per inbound message
// =============================================================================

function extractMentions(msg) {
  return msg.mentions ||
    msg.mention_user_ids ||
    msg.content?.mention_user_ids ||
    [];
}

/**
 * Apply DM / group access policy for a specific org. Returns:
 *   { handle: true, reason }   — message passes, agent should respond
 *   { handle: false, reason }  — message dropped (logged with reason)
 *   { handle: true, bindOwnerHint: {memberId, displayName} }
 *                              — pass + caller should auto-bind owner
 */
function shouldHandleMessage(msg, conv, orgConfig) {
  const selfMemberId = orgConfig.self?.member_id;

  // Skip self-echo: agent's own messages within this org.
  if (msg.sender_id && selfMemberId && msg.sender_id === selfMemberId) {
    return { handle: false, reason: 'self-echo' };
  }

  const convType = conv?.type || (msg.thread_id ? 'thread' : 'dm');
  const access = orgConfig.access || {};
  const senderId = msg.sender_id;
  const senderName = msg.sender_display_name || msg.sender?.display_name || '';

  if (convType === 'dm') {
    const policy = access.dmPolicy || 'owner';
    if (policy === 'open') return { handle: true, reason: 'dm:open' };
    if (policy === 'allowlist') {
      const list = (access.dmAllowFrom || []).map(String);
      if (list.includes(String(senderId))) return { handle: true, reason: 'dm:allowlist' };
      return { handle: false, reason: `dm:allowlist (sender ${senderId} not listed)` };
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
    if (String(owner.member_id) === String(senderId)) {
      return { handle: true, reason: 'dm:owner' };
    }
    return { handle: false, reason: `dm:owner (sender ${senderId} != bound owner ${owner.member_id})` };
  }

  // group / thread
  const policy = access.groupPolicy || 'allowlist';
  if (policy === 'disabled') return { handle: false, reason: 'group:disabled' };

  const convId = msg.conversation_id;
  const groupCfg = (access.groups || {})[convId];

  if (policy === 'allowlist' && !groupCfg) {
    return { handle: false, reason: `group:allowlist (${convId} not in groups{})` };
  }

  // mode: per-group `mode` if present, else default to 'mention'
  const mode = groupCfg?.mode || 'mention';
  if (mode === 'mention') {
    const mentions = extractMentions(msg);
    if (!selfMemberId || !mentions.includes(selfMemberId)) {
      return { handle: false, reason: 'group:mention (not @-ed)' };
    }
  }
  // mode === 'smart' bypasses the mention requirement

  // allowFrom: ['*'] / [] = all members allowed; otherwise restrict
  const allowFrom = groupCfg?.allowFrom;
  if (allowFrom && allowFrom.length > 0 && !allowFrom.includes('*')) {
    if (!allowFrom.map(String).includes(String(senderId))) {
      return { handle: false, reason: `group:allowFrom (sender ${senderId} not allowed in ${convId})` };
    }
  }

  return { handle: true, reason: `group:${policy}/${mode}` };
}

// =============================================================================
// Per-org inbound message handler
// =============================================================================

function makeOrgMessageHandler(orgConfig, sessionRef) {
  return async function handleIncomingMessage(payload) {
    const notification = payload?.payload || payload;
    if (!notification?.id || !notification.conversation_id) return;
    if (dedupe(notification.id)) return;

    const detail = await fetchMessageDetail(notification.conversation_id, notification.id);
    const msg = { ...notification, ...(detail || {}) };
    const conv = await fetchConversation(msg.conversation_id);
    if (conv) conv.id = conv.id || msg.conversation_id;

    const decision = shouldHandleMessage(msg, conv || {}, orgConfig);
    if (!decision.handle) {
      log(`drop [${orgConfig.slug}] msg=${msg.id}: ${decision.reason}`);
      return;
    }

    if (decision.bindOwnerHint) {
      const { memberId, displayName } = decision.bindOwnerHint;
      log(`bind owner [${orgConfig.slug}] member_id=${memberId} name="${displayName}"`);
      bindOwner(orgConfig.slug, memberId, displayName);
      // Mutate the captured orgConfig so subsequent decisions see the new owner.
      orgConfig.owner = { member_id: memberId, name: displayName || '' };
    }

    if (msg.seq && msg.seq > (sessionRef.last_seq || 0)) {
      sessionRef.last_seq = msg.seq;
      saveOrgSession(orgConfig.slug, { org_id: orgConfig.org_id, last_seq: msg.seq });
    }

    let recent = [];
    const convType = conv?.type || (msg.thread_id ? 'thread' : 'dm');
    if (convType !== 'dm') {
      const ctx = await fetchRecentMessages(
        msg.conversation_id,
        msg.seq,
        config.message?.context_messages,
      );
      recent = ctx.map(m => ({
        senderName: m.sender_display_name || m.senderName || m.sender_id,
        content:    m.content?.text || m.content_text || (typeof m.content === 'string' ? m.content : ''),
      }));
    }

    let mediaLocalPath;
    const content = msg.content || {};
    const mediaId = content.media_id;
    if (mediaId) {
      try {
        const { url } = await getMediaUrl(mediaId, orgConfig.org_id);
        if (url) mediaLocalPath = await downloadMedia(url, content.filename || mediaId);
      } catch (e) {
        warn('media fetch failed:', e.message);
      }
    }

    const senderName = msg.sender_display_name || msg.sender?.display_name || msg.sender_id;
    const endpoint = formatEndpoint({
      type: convType,
      conversationId: msg.conversation_id,
      threadConversationId: msg.thread_id || undefined,
      parentMessageId: msg.thread_id ? msg.parent_message_id : undefined,
    });
    const body = formatInboundForC4(
      { type: convType, id: msg.conversation_id },
      { displayName: senderName },
      {
        content: content.text || (typeof msg.content === 'string' ? msg.content : ''),
        type: msg.type === 'image' ? 'image' : (mediaId ? 'file' : 'text'),
        mediaLocalPath,
      },
      recent,
    );

    try {
      await forwardToC4(endpoint, body);
      log(`fwd [${orgConfig.slug}] ${convType} ${msg.conversation_id} msg=${msg.id} seq=${msg.seq}`);
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
// WS pool — one connection per enabled org
// =============================================================================

const wsClients = [];
let liveOrgCount = 0;

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
      const ticket = await getWsTicket(orgConfig.org_id);
      return `${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`;
    },
    deviceId:            config.agent?.device_id,
    clientVersion:       config.agent?.app_version,
    reconnectMaxMs:      config.server?.reconnect_max_delay,
    heartbeatIntervalMs: config.server?.heartbeat_interval,

    onOpen: () => log(`[${orgConfig.slug}] ws open (org=${orgConfig.org_id})`),

    onMessage: onFrame,

    onClose: (code, reason, willReconnect) => {
      log(`[${orgConfig.slug}] closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
      if (code === 4003) {
        log(`[${orgConfig.slug}] session expired; invalidating token cache`);
        invalidateToken(orgConfig.org_id);
        clearOrgSession(orgConfig.slug);
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
  for (const orgConfig of orgs) {
    startOrgWs(orgConfig, wsBaseUrl);
  }
}

watchConfig((next) => {
  config = next;
  log('config reloaded — WS settings apply on next reconnect; new/removed orgs require service restart');
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
