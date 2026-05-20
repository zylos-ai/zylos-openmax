#!/usr/bin/env node

/**
 * Communication bridge — PM2 service entry point.
 *
 * Implements cws-comm api-design.md §3-§4 client side:
 *   1. Opens WebSocket with Authorization+X-Workspace-Id headers.
 *   2. Sends ConnectRequest first frame, awaits ConnectResponse,
 *      persists session_token + user_id + last_seq into runtime/session.json.
 *   3. Handles inbound frames:
 *        message            → responseMode filter → ctx fetch → c4-receive
 *        sync_start         → expect sync_batch series
 *        sync_batch         → process messages + send sync_ack
 *        sync_complete      → enter push mode
 *        read_state_update / cross_device_sync / typing / presence / system
 *                           → ignored for now (TODO: surface useful ones)
 *        ping/pong          → handled by WsClient
 *        error              → log
 *   4. On close: routes by code (terminal vs reconnect vs session-expired).
 *
 * Conversation type lookup: when an inbound message arrives, the frame
 * carries conversation_id but not the conversation type. We fetch the
 * conversation via REST once and cache it for the dedup TTL window.
 */

import dotenv from 'dotenv';
import path from 'path';
import { execFile } from 'child_process';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

import { loadConfig, watchConfig } from './lib/config.js';
import { WsClient, createDeduper } from './lib/ws.js';
import { formatInboundForC4, formatEndpoint } from './lib/message.js';
import { downloadMedia } from './lib/media.js';
import { get, post, setSessionToken, setHeaders } from './lib/client.js';
import { saveSession, loadSession, clearSession } from './lib/session.js';
import {
  buildConnectFrame,
  parseConnectResponse,
  buildSyncAck,
  computeClockOffset,
} from './lib/connect.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'workspace';
const C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js',
);

function log(...a)  { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }

let config = loadConfig();
const dedupe = createDeduper(config.message?.dedup_ttl || 300000);

let sessionToken = '';
let userId = '';
let clockOffset = 0;
let lastSeq = 0;
let connected = false;          // WS open AND handshake complete

const conversationCache = new Map();  // id → {type, response_mode, ...}

function agentId() {
  return userId || config.agent?.id || config.agent?.participant_id || '';
}

function persistSession(extra) {
  try { saveSession({ ...extra, last_seq: lastSeq }); }
  catch (e) { warn('saveSession failed:', e.message); }
}

async function fetchConversation(conversationId) {
  if (conversationCache.has(conversationId)) return conversationCache.get(conversationId);
  try {
    const conv = await get(`/api/v1/conversations/${conversationId}`);
    conversationCache.set(conversationId, conv);
    return conv;
  } catch (e) {
    warn(`fetchConversation ${conversationId} failed:`, e.message);
    return null;
  }
}

async function fetchRecentMessages(conversationId, beforeSeq, limit) {
  try {
    const r = await get(`/api/v1/conversations/${conversationId}/messages`, {
      before_seq: beforeSeq,
      limit: limit || 10,
    });
    return Array.isArray(r) ? r : (r?.messages || r?.items || []);
  } catch (e) {
    warn('fetchRecentMessages failed:', e.message);
    return [];
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

function shouldHandleMessage(msg, conv) {
  if (msg.sender_id && msg.sender_id === agentId()) return false; // skip self-echo
  const mode = conv?.response_mode || conv?.metadata?.response_mode || 'at_only';
  if (mode === 'silent') return false;
  if (mode === 'proactive') return true;
  // at_only: DMs always; group requires @mention
  if (conv?.type === 'dm') return true;
  const mentions =
    msg.mentions ||
    msg.mention_user_ids ||
    msg.content?.mention_user_ids ||
    [];
  return mentions.includes(agentId());
}

async function handleIncomingMessage(payload) {
  const msg = payload?.payload || payload;
  if (!msg?.id || !msg.conversation_id) return;
  if (dedupe(msg.id)) return;

  const conv = await fetchConversation(msg.conversation_id);
  if (conv) conv.id = conv.id || msg.conversation_id;
  if (!shouldHandleMessage(msg, conv || {})) return;

  if (msg.seq && msg.seq > lastSeq) { lastSeq = msg.seq; persistSession(); }

  // Build context for group/thread
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

  // Media: optional attachment download
  let mediaLocalPath;
  const content = msg.content || {};
  const mediaId = content.media_id;
  if (mediaId) {
    try {
      const meta = await get(`/api/v1/media/${mediaId}/url`);
      const url = meta?.url || meta?.signed_url || meta?.download_url;
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
    log(`fwd ${convType} ${msg.conversation_id} msg=${msg.id} seq=${msg.seq}`);
  } catch (e) {
    warn('c4-receive failed:', e.message);
  }
}

async function processSyncBatch(payload) {
  const messages = payload?.messages || [];
  for (const m of messages) {
    await handleIncomingMessage({ payload: m });
  }
  const lastReceived = messages.length
    ? messages[messages.length - 1].seq
    : lastSeq;
  if (lastReceived > lastSeq) { lastSeq = lastReceived; persistSession(); }
  try { ws.send(buildSyncAck(lastSeq)); }
  catch (e) { warn('sync_ack send failed:', e.message); }
  log(`sync_batch: ${messages.length} msgs, ack last=${lastSeq}`);
}

function processConnectResponse(frame) {
  try {
    const cr = parseConnectResponse(frame);
    sessionToken = cr.sessionToken;
    userId = cr.userId || userId;
    clockOffset = computeClockOffset(cr.serverTime, Date.now());
    setSessionToken(sessionToken);
    persistSession({
      session_token: sessionToken,
      user_id: userId,
      workspace_id: config.workspace_id,
      server_time: cr.serverTime,
      received_at: Date.now(),
    });
    connected = true;
    log(`handshake OK user=${userId} maxSeq=${cr.maxSeq} clockOffset=${clockOffset}ms`);

    // ResumeResult inline path (small gap)
    if (cr.resume?.success && Array.isArray(cr.resume.missed_messages)) {
      log(`resume: ${cr.resume.missed_messages.length} missed messages inline`);
      for (const m of cr.resume.missed_messages) {
        handleIncomingMessage({ payload: m }).catch(e => warn('resume handler:', e.message));
      }
    }
    if (cr.resume?.new_session_token) {
      sessionToken = cr.resume.new_session_token;
      setSessionToken(sessionToken);
      persistSession({ session_token: sessionToken });
      log('session_token rotated');
    }
  } catch (e) {
    warn('connect_response parse failed:', e.message);
  }
}

function sendConnectRequest() {
  // Prefer api_key for handshake (we don't have a session yet)
  const apiKey =
    config.agent?.api_key ||
    process.env.COCO_AUTH_TOKEN ||
    sessionToken;
  if (!apiKey) {
    warn('no api_key/COCO_AUTH_TOKEN — handshake will be rejected');
  }
  if (!config.device_id) warn('device_id not set in config');
  if (!config.workspace_id) warn('workspace_id not set in config');
  const frame = buildConnectFrame({
    token:      apiKey || 'unset',
    clientId:   config.client_id || config.device_id || 'zylos',
    platform:   config.comm?.platform || 'server',
    lastSeq:    lastSeq,
    appVersion: config.app_version,
    deviceId:   config.device_id || 'zylos-dev',
  });
  try { ws.send(frame); log('sent connect frame'); }
  catch (e) { warn('connect frame send failed:', e.message); }
}

// --- WebSocket frame dispatch ---

function onFrame(frame) {
  const type = frame.type;
  switch (type) {
    case 'connect_response':
    case 'connect-response':
      processConnectResponse(frame);
      break;

    case 'message':
      handleIncomingMessage(frame).catch(e => warn('handleIncomingMessage:', e.message));
      break;

    case 'sync_start':
      log('sync_start received');
      break;
    case 'sync_batch':
      processSyncBatch(frame.payload || frame).catch(e => warn('processSyncBatch:', e.message));
      break;
    case 'sync_complete':
      log('sync_complete — entering push mode');
      break;

    case 'read_state_update':
    case 'cross_device_sync':
    case 'typing':
    case 'presence':
    case 'read_receipt':
    case 'system':
      // not actionable for the Agent yet — would surface to c4 in future
      break;

    case 'ping':
    case 'pong':
      // WsClient handles auto-reply; nothing more to do
      break;

    case 'error':
      warn('server error frame:', JSON.stringify(frame.payload || {}));
      break;

    default:
      log('unknown frame type:', type);
  }
}

// --- main ---

if (!config.enabled) {
  log('disabled in config, exiting');
  process.exit(0);
}
if (!config.workspace_id) {
  warn('workspace_id missing — set in ~/zylos/components/coco-workspace/config.json (post-install will prompt for it)');
}

setHeaders({
  // client.js will pull from config too, but seed explicit values here
});

// On boot, try to reuse a persisted session_token (warm restart)
const sess = loadSession();
if (sess?.session_token) {
  sessionToken = sess.session_token;
  userId = sess.user_id || '';
  lastSeq = sess.last_seq || 0;
  setSessionToken(sessionToken);
  log(`warm-restart: loaded session user=${userId} lastSeq=${lastSeq}`);
}

const wsUrl = process.env.COCO_WS_URL || config.comm?.ws_url;
if (!wsUrl) {
  console.error(LOG_PREFIX, 'COCO_WS_URL / config.comm.ws_url not set');
  process.exit(1);
}

const ws = new WsClient({
  url: wsUrl,
  // Use api_key for HTTP upgrade auth; the in-band connect frame also carries it.
  token: config.agent?.api_key || process.env.COCO_AUTH_TOKEN || sessionToken,
  workspaceId:   config.workspace_id,
  deviceId:      config.device_id,
  clientVersion: config.app_version,
  reconnectMaxMs: config.comm?.reconnect_max_delay,
  heartbeatIntervalMs: config.comm?.heartbeat_interval,

  onOpen: () => {
    connected = false;     // becomes true once connect_response arrives
    log(`ws open: ${wsUrl}`);
    sendConnectRequest();
  },

  onMessage: onFrame,

  onClose: (code, reason, willReconnect) => {
    connected = false;
    log(`closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
    if (code === 4003) {
      // session expired — clear so next handshake uses api_key fresh
      log('session expired; clearing session_token');
      sessionToken = '';
      setSessionToken(null);
      clearSession();
      ws.setToken(config.agent?.api_key || process.env.COCO_AUTH_TOKEN || '');
    }
  },

  onFatal: (code, reason) => {
    connected = false;
    console.error(LOG_PREFIX, `fatal close code=${code} reason="${reason || ''}" — not reconnecting`);
    if (code === 4002) console.error(LOG_PREFIX, '→ auth failed; check agent.api_key');
    if (code === 4005) console.error(LOG_PREFIX, '→ workspace suspended');
    if (code === 4006) console.error(LOG_PREFIX, '→ duplicate connection');
    process.exit(1);
  },
});

watchConfig((next) => {
  config = next;
  log('config reloaded — WS settings apply on next reconnect');
});

process.on('SIGTERM', () => { log('SIGTERM, stopping'); ws.stop(); process.exit(0); });
process.on('SIGINT',  () => { log('SIGINT, stopping');  ws.stop(); process.exit(0); });

log(`starting (ws=${wsUrl}, workspace=${config.workspace_id || '<unset>'}, device=${config.device_id || '<unset>'})`);
ws.start();
