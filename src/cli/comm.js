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
 * Build the cws-core v5 send-message body from caller input.
 *
 * cws-core schema (sendMessageRequest):
 *   {
 *     client_msg_id: "...",
 *     type: "TEXT" | "MARKDOWN" | "AGENT_TEXT" | "IMAGE" | "FILE" | "AGENT_STRUCTURED" | ...,
 *     content: {
 *       content_type: "text" | "markdown" | "image" | "file" | ...,
 *       body: { text, ... } | {},
 *       attachments: [{artifact_id, file_name, content_type, size_bytes}, ...]
 *     }
 *   }
 *
 * Caller can pass:
 *   - string                                            → text/markdown auto-detect
 *   - {text} | {body}                                   → text/markdown auto-detect
 *   - {content_type, body, attachments?}                → pass-through (advanced)
 *   - already-built object with top-level type+content  → returned as-is
 */
function buildSendBody(params) {
  // Allow advanced caller to override completely
  if (params.body && params.body.content && params.body.type) {
    return {
      client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
      ...params.body,
      ...(params.replyTo ? { parent_id: params.replyTo } : {}),
    };
  }
  const c = params.content;
  let msgType = params.type;
  let contentType, body, attachments;
  if (c && typeof c === 'object' && c.content_type) {
    // pre-built content object
    contentType = c.content_type;
    body        = c.body ?? {};
    attachments = c.attachments ?? [];
    if (!msgType) msgType = contentType === 'image' ? 'IMAGE'
                       : contentType === 'file' ? 'FILE'
                       : 'AGENT_TEXT';
  } else {
    const text = (typeof c === 'string') ? c
              : (c && typeof c === 'object') ? (c.text ?? c.body ?? '')
              : '';
    contentType = looksLikeMarkdown(text) ? 'markdown' : 'text';
    body        = { text: String(text) };
    attachments = [];
    if (!msgType) msgType = 'AGENT_TEXT';
  }
  return {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    type:          msgType,
    content:       { content_type: contentType, body, attachments },
    ...(params.replyTo ? { parent_id: params.replyTo } : {}),
  };
}

const COMMANDS = {
  // ---- Conversation collection -------------------------------------------------
  // ✅ GET /api/v1/conversations
  'comm.list_conversations': () => get(apiPath('/conversations'), {
    cursor:           params.cursor ?? params.pageToken,
    limit:            params.limit  ?? params.pageSize,
    include_archived: params.includeArchived,
  }),

  // ✅ POST /api/v1/conversations/dm    body {peer_member_id}
  // ✅ POST /api/v1/conversations/groups body {name, member_ids, description?, avatar_media_id?, metadata?}
  //   cws-core derives org_id and caller member_id from the JWT — do NOT send them.
  'comm.create_dm':    () => post(apiPath('/conversations/dm'), {
    peer_member_id: params.peerMemberId || params.participantId || params.peerId,
  }),
  'comm.create_group': () => post(apiPath('/conversations/groups'), {
    name:             params.name || params.title,
    member_ids:       params.memberIds || params.participantIds,
    description:      params.description,
    avatar_media_id:  params.avatarMediaId,
    metadata:         params.metadata,
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
  //   body: {client_msg_id, type, content:{content_type, body, attachments}, parent_id?}
  //   See buildSendBody() for the schema details.
  'comm.send': () => post(apiPath(`/conversations/${params.conversationId}/messages`), buildSendBody(params)),

  // ✅ GET /api/v1/conversations/{id}/messages/{msg_id}
  'comm.get_message': () => get(
    apiPath(`/conversations/${params.conversationId}/messages/${params.messageId}`),
  ),

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
  comm.create_dm            {peerMemberId}                           # POST /conversations/dm
  comm.create_group         {name, memberIds, description?}          # POST /conversations/groups
  comm.get_conversation     {conversationId}

Messages
  comm.send                 {conversationId, content, replyTo?, clientMsgId?}
                            # content: string | {text|body, markdown?} | {type,body} | [{type,body}]
  comm.get_messages         {conversationId, afterSeq?, beforeSeq?, limit?}
  comm.get_message          {conversationId, messageId}

Read receipts
  comm.unread               {conversationId}                         # GET  /conversations/{id}/unread

Search (KB pages only)
  comm.search               {query, kbId?, limit?, offset?, sort?}   # GET /search/pages

Sync (WS reconnect catch-up)
  comm.sync                 {sinceSeq, deviceId, limit?}             # POST /sync

Environment:
  COCO_API_URL       cws-core base URL (default: http://127.0.0.1:8080)
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
