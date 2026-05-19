#!/usr/bin/env node

/**
 * Communication bridge — PM2 service entry point.
 *
 * Per DESIGN.md §3:
 *   - Holds a WebSocket long connection to cws-comm.
 *   - Translates `message:new` / `thread:created` / `sync:response` frames
 *     into the C4 bridge inbound format (`[COCO ...] X said: ...`).
 *   - Applies responseMode filter (at_only / proactive / silent).
 *   - Builds group/thread context (recent N messages) before forwarding.
 *   - Deduplicates by message id with TTL cache.
 *   - Auto-joins threads where the agent is a parent participant.
 *
 * The cws-comm protocol is not yet finalised (DESIGN.md §8 待细化 #1).
 * Frame shape assumed here: `{event:'message:new', data:{message, conversation, sender}}`.
 * Adjust handlers once cws-comm publishes the wire format.
 */

import dotenv from 'dotenv';
import path from 'path';
import { execFile } from 'child_process';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

import { loadConfig, watchConfig } from './lib/config.js';
import { WsClient, createDeduper } from './lib/ws.js';
import { formatInboundForC4, formatEndpoint } from './lib/message.js';
import { downloadMedia } from './lib/media.js';
import { get, post } from './lib/client.js';

const LOG_PREFIX = '[comm-bridge]';
const CHANNEL = 'workspace';
const C4_RECEIVE = path.join(
  process.env.HOME || '',
  'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js',
);

function log(...args) { console.log(LOG_PREFIX, ...args); }
function warn(...args) { console.warn(LOG_PREFIX, ...args); }

let config = loadConfig();
const dedupe = createDeduper(config.message?.dedup_ttl || 300000);

function agentId() {
  return config.agent?.id || config.agent?.participant_id || '';
}

function shouldHandle(message, conversation) {
  const mode = conversation?.response_mode || conversation?.responseMode || 'at_only';
  if (mode === 'silent') return false;
  if (mode === 'proactive') return true;
  if (conversation?.type === 'dm') return true;
  const mentions = message?.mentions || message?.mention_participant_ids || [];
  return mentions.includes(agentId());
}

async function fetchRecentMessages(conversationId, beforeSeq, limit) {
  try {
    const r = await get('/api/conversations/messages', {
      conversation_id: conversationId,
      before_seq: beforeSeq,
      limit: limit || 10,
    });
    return Array.isArray(r) ? r : (r?.items || []);
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

async function handleMessageNew(data) {
  const { message, conversation, sender } = data || {};
  if (!message?.id || !conversation?.id) return;
  if (dedupe(message.id)) return;
  if (!shouldHandle(message, conversation)) return;

  let recent = [];
  if (conversation.type !== 'dm') {
    const ctx = await fetchRecentMessages(
      conversation.id,
      message.seq,
      config.message?.context_messages,
    );
    recent = ctx.map(m => ({
      senderName: m.sender_display_name || m.senderName || m.sender_id,
      content:    m.content_text || m.content || '',
    }));
  }

  let mediaLocalPath;
  const attachments = message.attachments || [];
  if (attachments.length) {
    const att = attachments[0];
    const url = att.download_url || att.url;
    if (url) {
      try { mediaLocalPath = await downloadMedia(url, att.filename); }
      catch (e) { warn('media download failed:', e.message); }
    }
  }

  const endpoint = formatEndpoint({
    type: conversation.type,
    conversationId: conversation.id,
    threadConversationId: conversation.type === 'thread' ? conversation.id : undefined,
    parentMessageId: conversation.type === 'thread'
      ? (conversation.thread_parent_message_id || conversation.parentMessageId)
      : undefined,
  });

  const body = formatInboundForC4(
    { type: conversation.type, id: conversation.id },
    { displayName: sender?.display_name || sender?.displayName || sender?.id },
    {
      content: message.content_text || message.content || '',
      type: message.type === 'image'
        ? 'image'
        : (attachments.length ? 'file' : 'text'),
      mediaLocalPath,
    },
    recent,
  );

  try {
    await forwardToC4(endpoint, body);
    log(`forwarded ${conversation.type} ${conversation.id} msg=${message.id}`);
  } catch (e) {
    warn('c4-receive failed:', e.message);
  }
}

async function handleThreadCreated(data) {
  const thread = data?.thread || data;
  if (!thread?.id) return;
  const participants = thread.parent_participant_ids || thread.parent_participants || [];
  if (!participants.includes(agentId())) return;

  try {
    await post(`/api/threads/${thread.id}/join`, {});
    log(`auto-joined thread ${thread.id}`);
  } catch (e) {
    warn(`thread join ${thread.id} failed:`, e.message);
  }
}

function sendSyncRequest(ws, lastSeq) {
  if (!lastSeq) return;
  try {
    ws.send({ event: 'sync:request', data: { last_seq: lastSeq } });
    log(`sync:request lastSeq=${lastSeq}`);
  } catch (e) {
    warn('sync:request failed:', e.message);
  }
}

// --- main ---

if (!config.enabled) {
  log('disabled in config.json, exiting');
  process.exit(0);
}

const token  = process.env.COCO_AUTH_TOKEN || '';
const wsUrl  = process.env.COCO_WS_URL || config.comm?.ws_url;
if (!token) warn('COCO_AUTH_TOKEN not set — connection will likely be rejected');
if (!wsUrl) {
  console.error(LOG_PREFIX, 'COCO_WS_URL / config.comm.ws_url not set');
  process.exit(1);
}

let lastSeq = 0;

const ws = new WsClient({
  url: wsUrl,
  token,
  reconnectMaxMs: config.comm?.reconnect_max_delay,
  heartbeatIntervalMs: config.comm?.heartbeat_interval,

  onOpen: (client) => {
    log(`connected: ${wsUrl}`);
    if (lastSeq) sendSyncRequest(client, lastSeq);
  },

  onMessage: (frame) => {
    const event = frame.event || frame.type;
    const data  = frame.data || frame;
    if (data?.message?.seq && data.message.seq > lastSeq) lastSeq = data.message.seq;

    switch (event) {
      case 'message:new':
        handleMessageNew(data).catch(e => warn('handleMessageNew:', e.message));
        break;
      case 'thread:created':
        handleThreadCreated(data).catch(e => warn('handleThreadCreated:', e.message));
        break;
      case 'sync:response':
        for (const m of data?.messages || []) {
          handleMessageNew({ message: m, conversation: m.conversation, sender: m.sender })
            .catch(e => warn('sync handler:', e.message));
        }
        break;
      case 'pong':
        break;
      default:
        log('unknown frame event:', event);
    }
  },

  onClose: (code, reason) => log(`closed code=${code} reason="${reason || ''}"`),
});

watchConfig((next) => {
  config = next;
  log('config reloaded (WS settings apply on next reconnect)');
});

process.on('SIGTERM', () => { log('SIGTERM, stopping'); ws.stop(); process.exit(0); });
process.on('SIGINT',  () => { log('SIGINT, stopping');  ws.stop(); process.exit(0); });

log(`starting (ws=${wsUrl}, agent=${agentId() || '<unset>'})`);
ws.start();
