#!/usr/bin/env node

/**
 * Communication bridge — PM2 service entry point.
 *
 * Implements cws-comm api-usage-guide §1 + §6 (Agent integration):
 *   1. Opens WebSocket directly to cws-comm with `Authorization: Bearer
 *      <api_key>` + `X-Workspace-Id` headers (no ws-ticket pre-fetch).
 *   2. Sends ConnectRequest first frame (token = api_key), awaits
 *      ConnectResponse, persists session_token + user_id + last_seq
 *      into runtime/session.json.
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
import http from 'http';
import fs from 'fs';
import { execFile } from 'child_process';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

import { loadConfig, watchConfig } from './lib/config.js';
import { WsClient, createDeduper } from './lib/ws.js';
import { formatInboundForC4, formatEndpoint, splitMessage, looksLikeMarkdown } from './lib/message.js';
import { getMediaUrl, downloadMedia } from './cli/as.js';
import { get, post, setApiKey, setHeaders, apiPath } from './lib/client.js';
import { newClientMsgId } from './lib/message.js';
import { getWsTicket, invalidate as invalidateToken } from './lib/token.js';
import { saveSession, loadSession, clearSession } from './lib/session.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'coco-workspace';

const HOME        = process.env.HOME || '';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/coco-workspace/runtime');
const BRIDGE_PATH = path.join(RUNTIME_DIR, 'bridge.json');
const C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js',
);

function log(...a)  { console.log(LOG_PREFIX, ...a); }
function warn(...a) { console.warn(LOG_PREFIX, ...a); }

let config = loadConfig();
const dedupe = createDeduper(config.message?.dedup_ttl || 300000);

let lastSeq = 0;
let connected = false;          // true once WS upgrade succeeds (ticket auth done)

const conversationCache = new Map();  // id → {type, response_mode, ...}

function agentId() {
  // cws-comm authenticates at WS upgrade via ticket; the bridge no longer
  // exchanges a connect/connect_response handshake that previously seeded
  // userId. We use the identity_id captured during register-agent.
  return config.agent?.identity_id || config.agent?.id || '';
}

function persistSession(extra) {
  try { saveSession({ ...extra, last_seq: lastSeq }); }
  catch (e) { warn('saveSession failed:', e.message); }
}

async function fetchConversation(conversationId) {
  if (conversationCache.has(conversationId)) return conversationCache.get(conversationId);
  // TODO: cws-core OpenAPI does not yet expose GET /conversations/{id}.
  // When it lands, this path is correct. For now the call may 404 and
  // we degrade gracefully (handleIncomingMessage tolerates a null conv).
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
  // cws-core OpenAPI: GET /api/v1/conversations/{id}/messages?after_seq=&before_seq=&limit=
  try {
    const r = await get(apiPath(`/conversations/${conversationId}/messages`), {
      before_seq: beforeSeq,
      limit:      limit || 10,
    });
    return Array.isArray(r) ? r : (r?.messages || r?.items || []);
  } catch (e) {
    warn('fetchRecentMessages failed:', e.message);
    return [];
  }
}

// cws-comm pushes WS `message` frames with only metadata (id, conv_id, sender,
// type, seq, timestamp) — see cws-comm/internal/transport/ws/gateway_consumer.go.
// To get content (text, media_id, etc.) the agent must REST-fetch the full
// message from cws-core. If the fetch fails (endpoint not yet implemented,
// permission, etc.) we fall back to the notification fields alone so basic
// metadata-only handling still works.
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
  const notification = payload?.payload || payload;
  if (!notification?.id || !notification.conversation_id) return;
  if (dedupe(notification.id)) return;

  // cws-comm pushes only notification metadata. Fetch full message detail
  // (content, media, mentions) from cws-core. If the call fails, fall back
  // to notification fields so we at least record the metadata.
  const detail = await fetchMessageDetail(notification.conversation_id, notification.id);
  const msg = { ...notification, ...(detail || {}) };

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
      const { url } = await getMediaUrl(mediaId);
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

// --- WebSocket frame dispatch ---

// Cumulative frame.type counter for protocol-alignment metrics.
// Used to verify which types cws-comm actually pushes vs which our switch
// expects but never sees. Dumped every WS_METRIC_INTERVAL_MS to logs.
const _frameTypeCounts = Object.create(null);
const WS_METRIC_INTERVAL_MS = 5 * 60 * 1000;
let _frameMetricTimer = null;

function recordFrameType(type) {
  const k = type || '(missing-type)';
  _frameTypeCounts[k] = (_frameTypeCounts[k] || 0) + 1;
}

function dumpFrameMetrics() {
  const entries = Object.entries(_frameTypeCounts);
  if (entries.length === 0) {
    log('ws frame metric: no frames received in this window');
    return;
  }
  entries.sort((a, b) => b[1] - a[1]);
  const formatted = entries.map(([t, n]) => `${t}=${n}`).join(' ');
  log(`ws frame metric (cumulative since boot): ${formatted}`);
}

function startFrameMetricTimer() {
  if (_frameMetricTimer) return;
  _frameMetricTimer = setInterval(dumpFrameMetrics, WS_METRIC_INTERVAL_MS);
  _frameMetricTimer.unref?.();
}

// Canonical cws-comm WS frame types (see cws-comm/internal/transport/ws/frame.go):
//   message, message_ack, typing, read_receipt, presence,
//   system, error, read_state_update
// cws-comm does NOT push connect_response / sync_* / cross_device_sync /
// ping / pong text frames; ping/pong is handled at the WS protocol layer
// by WsClient automatically.
function onFrame(frame) {
  const type = frame.type;
  recordFrameType(type);
  switch (type) {
    case 'message':
      // cws-comm pushes a notification envelope without `content` —
      // the agent needs to REST-fetch the full message before processing.
      // TODO(protocol-alignment): implement notification → REST fetch path.
      handleIncomingMessage(frame).catch(e => warn('handleIncomingMessage:', e.message));
      break;

    case 'message_ack':
      // cws-comm acknowledges an outbound message delivery. For now we just
      // log; later we could correlate with client_msg_id from POST /messages.
      log(`message_ack seq=${frame.payload?.seq} msg=${frame.payload?.message_id}`);
      break;

    case 'system':
      // cws-comm system events (message.updated/deleted/recalled etc.).
      // Pass-through log; future: surface specific events to C4.
      log(`system event=${frame.payload?.event || '<unknown>'} conv=${frame.payload?.conversation_id || '<unknown>'}`);
      break;

    case 'error':
      warn('server error frame:', JSON.stringify(frame.payload || {}));
      break;

    case 'typing':
    case 'presence':
    case 'read_receipt':
    case 'read_state_update':
      // not actionable for the Agent yet — would surface to C4 in future
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

// On boot, reuse persisted last_seq for diagnostic continuity. session_token
// and user_id are no longer maintained — cws-comm authenticates at WS upgrade
// via ticket, and the agent's identity comes from config.agent.identity_id.
const sess = loadSession();
if (sess) {
  lastSeq = sess.last_seq || 0;
  log(`warm-restart: loaded lastSeq=${lastSeq}`);
}

const wsUrl = process.env.COCO_WS_URL || config.comm?.ws_url;
if (!wsUrl) {
  console.error(LOG_PREFIX, 'COCO_WS_URL / config.comm.ws_url not set');
  process.exit(1);
}

// Warn early if api_key is missing — token.js will fail at exchange time.
if (!process.env.COCO_AUTH_TOKEN && !config.agent?.api_key) {
  warn('no api_key/COCO_AUTH_TOKEN — token exchange will fail');
}
if (!config.org_id && !process.env.COCO_ORG_ID) {
  warn('org_id not set — ws-ticket exchange will fail');
}

// urlProvider: called before every connect attempt.
// Fetches a fresh one-time WS ticket via:
//   token.js.getAccessToken() → POST /auth/agent/token or /auth/refresh
//   token.js.getWsTicket()    → POST /auth/ws-ticket
// The ticket is appended as ?ticket=<value> to the WS URL.
// No Authorization header is sent on the WS upgrade — the ticket is auth.
const wsBaseUrl = wsUrl.replace(/\?.*$/, '');

const ws = new WsClient({
  urlProvider: async () => {
    const ticket = await getWsTicket(config.org_id);
    return `${wsBaseUrl}?ticket=${encodeURIComponent(ticket)}`;
  },
  // No `token` — auth is via ticket in URL, not the Authorization header.
  workspaceId:         config.workspace_id,
  deviceId:            config.device_id,
  clientVersion:       config.app_version,
  reconnectMaxMs:      config.comm?.reconnect_max_delay,
  heartbeatIntervalMs: config.comm?.heartbeat_interval,

  onOpen: () => {
    // cws-comm: ticket auth happens at HTTP upgrade time, so a successful
    // ws.open IS the handshake. No connect/connect_response round-trip needed.
    connected = true;
    log('ws open — ready');
  },

  onMessage: onFrame,

  onClose: (code, reason, willReconnect) => {
    connected = false;
    log(`closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
    if (code === 4003) {
      // session expired — invalidate token cache so the next connect attempt
      // re-exchanges the api_key for a fresh JWT + ticket.
      log('session expired; invalidating token cache and clearing session');
      invalidateToken();
      clearSession();
    }
  },

  onFatal: (code, reason) => {
    connected = false;
    console.error(LOG_PREFIX, `fatal close code=${code} reason="${reason || ''}" — not reconnecting`);
    if (code === 4002) console.error(LOG_PREFIX, '→ auth failed; check COCO_AUTH_TOKEN / org_id');
    if (code === 4005) console.error(LOG_PREFIX, '→ workspace suspended');
    if (code === 4006) console.error(LOG_PREFIX, '→ duplicate connection');
    process.exit(1);
  },
});

watchConfig((next) => {
  config = next;
  log('config reloaded — WS settings apply on next reconnect');
});

// ── IPC send server ──────────────────────────────────────────────────────────
// send.js (Claude's outbound subprocess) POSTs here; we forward via the open
// WS connection so the reply reaches users in the same conversation they used.
//
// POST /send  body: { conversationId, text, threadId?, replyTo? }
//   conversationId — already resolved by send.js (DM conv, group conv, or
//                    thread conv depending on endpoint type)
//   threadId       — set only for thread-type endpoints
//   replyTo        — set for group reply-to-message endpoints
//
// Long messages are split into ≤3000-char chunks (paragraph → newline → hard)
// and sent as sequential frames to the same conversation. Each chunk gets its
// own client_msg_id, so the server de-dupes them independently.

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ipcServer = http.createServer(async (req, res) => {
  const reply = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };

  if (req.method !== 'POST' || req.url !== '/send') {
    return reply(404, { error: 'not found' });
  }

  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return reply(400, { error: 'invalid JSON' });
  }

  const { conversationId, text, threadId, replyTo } = payload;
  if (!conversationId || typeof text !== 'string') {
    return reply(400, { error: 'conversationId and text required' });
  }

  // Outbound goes through cws-core (REST). cws-core will forward to cws-comm
  // (implementation may still be pending — calls may surface as 501/404 from
  // the server until then; that's the cws-core team's responsibility).
  // Schema matches scripts/send.js — POST /api/v1/conversations/{id}/messages
  // with { client_msg_id, content: MessageContent[], reply_to? }.
  const chunks = splitMessage(text);
  const results = [];
  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const blockType = looksLikeMarkdown(chunk) ? 'markdown' : 'text';
      const body = {
        client_msg_id: newClientMsgId(),
        content:       [{ type: blockType, body: chunk }],
        // reply_to only set on first chunk to avoid duplicate threading
        ...(i === 0 && replyTo ? { reply_to: replyTo } : {}),
      };
      // eslint-disable-next-line no-await-in-loop
      const res = await post(apiPath(`/conversations/${conversationId}/messages`), body);
      results.push(res?.id || res?.message_id || null);
    }
    log(`ipc→rest conv=${conversationId} chunks=${chunks.length}${threadId ? ' (threadId ignored — schema TBD)' : ''}`);
    reply(200, { ok: true, chunks: chunks.length, message_ids: results });
  } catch (e) {
    warn('ipc /send REST POST failed:', e.message);
    reply(e.status || 500, { error: e.message, status: e.status });
  }
});

ipcServer.listen(0, '127.0.0.1', () => {
  const { port } = ipcServer.address();
  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(BRIDGE_PATH, JSON.stringify({ port, pid: process.pid }));
  } catch (e) { warn('bridge.json write failed:', e.message); }
  log(`IPC server on 127.0.0.1:${port}`);
});

function removeBridgeFile() { try { fs.unlinkSync(BRIDGE_PATH); } catch {} }
process.on('SIGTERM', () => { removeBridgeFile(); log('SIGTERM, stopping'); ipcServer.close(); ws.stop(); process.exit(0); });
process.on('SIGINT',  () => { removeBridgeFile(); log('SIGINT, stopping');  ipcServer.close(); ws.stop(); process.exit(0); });

log(`starting (ws=${wsBaseUrl}?ticket=..., workspace=${config.workspace_id || '<unset>'}, device=${config.device_id || '<unset>'})`);
startFrameMetricTimer();
ws.start();
