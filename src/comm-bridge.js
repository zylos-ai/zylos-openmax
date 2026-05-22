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
import { formatInboundForC4, formatEndpoint, buildWsSendFrame } from './lib/message.js';
import { getMediaUrl, downloadMedia } from './cli/as.js';
import { get, setApiKey, setHeaders, apiPath } from './lib/client.js';
import { getAccessToken, getWsTicket, invalidate as invalidateToken } from './lib/token.js';
import { saveSession, loadSession, clearSession } from './lib/session.js';
import {
  buildConnectFrame,
  parseConnectResponse,
  buildSyncAck,
  computeClockOffset,
} from './lib/connect.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'coco-workspace';

const HOME = process.env.HOME || '';
const RUNTIME_DIR = path.join(HOME, 'zylos/components/coco-workspace/runtime');
const BRIDGE_PATH  = path.join(RUNTIME_DIR, 'bridge.json');
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
    // NOTE: session_token authenticates WS frames on the direct cws-comm
    // link only. REST goes through cws-core with the agent's api_key —
    // do not overwrite the REST client's token here.
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
      persistSession({ session_token: sessionToken });
      log('session_token rotated');
    }
  } catch (e) {
    warn('connect_response parse failed:', e.message);
  }
}

async function sendConnectRequest() {
  // ConnectRequest.token = JWT access_token (not api_key).
  // By this point urlProvider has already fetched the ws-ticket and
  // getAccessToken() is cached in token.js, so this is a fast in-memory read.
  let token;
  try {
    token = await getAccessToken(config.org_id);
  } catch (e) {
    warn('getAccessToken failed for ConnectRequest, falling back to api_key:', e.message);
    token = config.agent?.api_key || process.env.COCO_AUTH_TOKEN || '';
  }
  if (!token) warn('no token for ConnectRequest — handshake will be rejected');
  if (!config.device_id) warn('device_id not set in config');
  if (!config.workspace_id) warn('workspace_id not set in config');
  const frame = buildConnectFrame({
    token:      token || 'unset',
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

// On boot, try to reuse persisted runtime state (warm restart).
// session_token is NOT seeded into the REST client — REST uses api_key
// via cws-core. session_token only authenticates WS frames.
const sess = loadSession();
if (sess) {
  sessionToken = sess.session_token || '';
  userId = sess.user_id || '';
  lastSeq = sess.last_seq || 0;
  log(`warm-restart: loaded user=${userId} lastSeq=${lastSeq}`);
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
    connected = false;     // becomes true once connect_response arrives
    log('ws open');
    sendConnectRequest().catch(e => warn('sendConnectRequest failed:', e.message));
  },

  onMessage: onFrame,

  onClose: (code, reason, willReconnect) => {
    connected = false;
    log(`closed code=${code} reason="${reason || ''}" reconnect=${willReconnect}`);
    if (code === 4003) {
      // JWT session expired — invalidate token cache so the next connect
      // attempt re-exchanges the api_key for a fresh JWT + ticket.
      log('session expired; invalidating token cache and clearing session');
      invalidateToken();
      sessionToken = '';
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

// ── IPC server: send.js posts here → WS frame → cws-comm → user ─────────────
const ipcServer = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/send') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    try {
      const { conversationId, text, msgType, threadId, replyTo } = JSON.parse(body);
      if (!conversationId || text === undefined) throw new Error('conversationId and text required');
      if (!connected) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ws not connected' }));
        return;
      }
      const frame = buildWsSendFrame({
        workspaceId: config.workspace_id,
        conversationId,
        text,
        msgType,
        threadId,
        replyTo,
      });
      ws.send(frame);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      log(`ipc send → conv=${conversationId} type=${msgType || 'text'}`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
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
ws.start();
