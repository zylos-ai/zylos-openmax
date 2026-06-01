#!/usr/bin/env node

/**
 * Communication CLI — IM operations against cws-core
 * (paths and shapes match the live OpenAPI at
 *  https://zylos01.jinglever.com/cws-core/openapi.json).
 *
 * Reactive IM (Agent replying to a user via the WebSocket frame) is handled
 * by `src/comm-bridge.js` automatically. This CLI is for proactive IM:
 * starting a new DM, sending into a non-current conversation, pulling
 * history, etc.
 *
 * WebSocket frames stay on the direct cws-comm link (src/lib/ws.js) —
 * this CLI is REST only.
 *
 * Usage:
 *   node src/cli/comm.js <command> '<json-params>'
 *   node src/cli/comm.js comm.send '{"conversationId":"cv-1","content":"hi"}'
 *
 * Status:
 *   ✅  available in cws-core today
 *   ⏳  not exposed by cws-core yet (call will 404); kept here so the
 *      surface is ready when core adds the endpoint
 */

import { randomUUID } from 'crypto';
import { get, post, del, apiPath } from '../lib/client.js';
import { looksLikeMarkdown } from '../lib/message.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

function ensureClientMsgId(id) {
  return id || `cmsg_${randomUUID()}`;
}

/**
 * Normalize caller-supplied content into cws-core's MessageContent[] shape:
 *   - string                                  → [{type:"text"|"markdown", body}]
 *   - {text, markdown?}                       → [{type:"text"|"markdown", body:text}]
 *   - {type, body}                            → [{type, body}]   (pre-built block)
 *   - [{type, body}, ...]                     → passthrough
 */
function normalizeContent(c) {
  if (c == null) return [{ type: 'text', body: '' }];
  if (typeof c === 'string') {
    return [{ type: looksLikeMarkdown(c) ? 'markdown' : 'text', body: c }];
  }
  if (Array.isArray(c)) return c;
  if (typeof c === 'object' && c.body != null && c.type != null) return [c];
  // Legacy envelope {text, format?, markdown?}
  if (typeof c === 'object' && (c.text != null || c.body != null)) {
    const body = c.body ?? c.text ?? '';
    const type = c.type || (c.markdown || c.format === 'markdown' ? 'markdown' : 'text');
    return [{ type, body }];
  }
  return [{ type: 'text', body: String(c) }];
}

const COMMANDS = {
  // ---- Conversation collection -------------------------------------------------
  // ✅ GET /api/v1/conversations
  'comm.list_conversations': () => get(apiPath('/conversations'), {
    cursor:           params.cursor ?? params.pageToken,
    limit:            params.limit  ?? params.pageSize,
    include_archived: params.includeArchived,
  }),

  // ✅ POST /api/v1/conversations/dm   body {participant_id}
  // ✅ POST /api/v1/conversations/groups  body {title, member_ids}
  'comm.create_dm':    () => post(apiPath('/conversations/dm'), {
    participant_id: params.participantId,
  }),
  'comm.create_group': () => post(apiPath('/conversations/groups'), {
    title:      params.title,
    member_ids: params.memberIds || params.participantIds,
  }),

  // ✅ GET /api/v1/conversations/{id}
  'comm.get_conversation': () => get(apiPath(`/conversations/${params.conversationId}`)),

  // ---- Messages ---------------------------------------------------------------
  // ✅ GET /api/v1/conversations/{id}/messages?after_seq=&before_seq=&limit=
  'comm.get_messages': () => get(apiPath(`/conversations/${params.conversationId}/messages`), {
    after_seq:  params.afterSeq,
    before_seq: params.beforeSeq,
    limit:      params.limit,
  }),

  // ✅ POST /api/v1/conversations/{id}/messages
  'comm.send': () => post(apiPath(`/conversations/${params.conversationId}/messages`), {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    content:       normalizeContent(params.content),
    reply_to:      params.replyTo,
  }),

  // ✅ GET /api/v1/conversations/{id}/messages/{msg_id}
  'comm.get_message': () => get(
    apiPath(`/conversations/${params.conversationId}/messages/${params.messageId}`),
  ),

  // ✅ DELETE /api/v1/conversations/{id}/messages/{msg_id}
  'comm.delete_message': () => del(
    apiPath(`/conversations/${params.conversationId}/messages/${params.messageId}`),
  ),

  // ✅ POST /api/v1/conversations/{id}/read    body {message_id?, seq?}
  'comm.mark_read': () => post(apiPath(`/conversations/${params.conversationId}/read`), {
    message_id: params.messageId,
    seq:        params.seq,
  }),
  // ✅ GET /api/v1/conversations/{id}/unread
  'comm.unread': () => get(apiPath(`/conversations/${params.conversationId}/unread`)),

  // ✅ GET /api/v1/search/pages  — KB page search (only search surface in v5)
  'comm.search': () => get(apiPath('/search/pages'), {
    query:  params.query || params.q,
    kb_id:  params.kbId,
    limit:  params.limit  ?? params.pageSize,
    offset: params.offset,
    sort:   params.sort,
  }),

  // ✅ POST /api/v1/sync   body {since_seq, device_id, limit?}
  // Pull missed events after WS reconnect.
  'comm.sync': () => post(apiPath('/sync'), {
    since_seq: params.sinceSeq,
    device_id: params.deviceId,
    limit:     params.limit,
  }),
};

function printUsage() {
  console.log(`Comm CLI — IM operations on cws-core (contract-v5)

Usage: node src/cli/comm.js <command> '<json-params>'

Conversations
  comm.list_conversations   {cursor?, limit?, includeArchived?}
  comm.create_dm            {participantId}                          # POST /conversations/dm
  comm.create_group         {title, memberIds}                       # POST /conversations/groups
  comm.get_conversation     {conversationId}

Messages
  comm.send                 {conversationId, content, replyTo?, clientMsgId?}
                            # content: string | {text|body, markdown?} | {type,body} | [{type,body}]
  comm.get_messages         {conversationId, afterSeq?, beforeSeq?, limit?}
  comm.get_message          {conversationId, messageId}
  comm.delete_message       {conversationId, messageId}

Read receipts
  comm.mark_read            {conversationId, messageId?, seq?}       # POST /conversations/{id}/read
  comm.unread               {conversationId}                         # GET  /conversations/{id}/unread

Search (KB pages only)
  comm.search               {query, kbId?, limit?, offset?, sort?}   # GET /search/pages

Sync (WS reconnect catch-up)
  comm.sync                 {sinceSeq, deviceId, limit?}             # POST /sync

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
  COCO_AUTH_TOKEN    Bearer token
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
`);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printUsage();
    process.exit(0);
  }
  const handler = COMMANDS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
  }
  try {
    const result = await handler();
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
