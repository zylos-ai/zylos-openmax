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
import { get, post, patch, del, apiPath } from '../lib/client.js';
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
  // ✅ core: GET /api/v1/conversations?page_size=&page_token=
  'comm.list_conversations': () => get(apiPath('/conversations'), {
    page_size:  params.pageSize  ?? params.limit,
    page_token: params.pageToken ?? params.cursor,
  }),

  // ✅ core: POST /api/v1/conversations  body {type, title?, participant_ids?}
  // For DMs, participant_ids should be exactly one other member.
  // P0 only supports type ∈ {dm, group}; broadcast/bridge not yet.
  'comm.create_conversation': () => post(apiPath('/conversations'), {
    type:            params.type,
    title:           params.title,
    participant_ids: params.participantIds || params.memberIds,
  }),
  'comm.create_dm': () => post(apiPath('/conversations'), {
    type:            'dm',
    participant_ids: [params.participantId],
  }),

  // ⏳ core MISSING — single conversation GET. Listed for forward-compat;
  //                  comm-bridge falls back to null when this 404s.
  'comm.get_conversation': () => get(apiPath(`/conversations/${params.conversationId}`)),

  // ---- Messages ---------------------------------------------------------------
  // ✅ core: GET /api/v1/conversations/{id}/messages?after_seq=&before_seq=&limit=
  'comm.get_messages': () => get(apiPath(`/conversations/${params.conversationId}/messages`), {
    after_seq:  params.afterSeq,
    before_seq: params.beforeSeq,
    limit:      params.limit,
  }),

  // ✅ core: POST /api/v1/conversations/{id}/messages
  //          body { client_msg_id, content: [{type,body}], reply_to? }
  'comm.send': () => post(apiPath(`/conversations/${params.conversationId}/messages`), {
    client_msg_id: ensureClientMsgId(params.clientMsgId || params.clientMessageId),
    content:       normalizeContent(params.content),
    reply_to:      params.replyTo,
  }),

  // ⏳ core MISSING — message edit/delete/pin not yet exposed.
  'comm.edit_message':   () => patch(apiPath(`/messages/${params.messageId}`), {
    content: normalizeContent(params.content),
  }),
  'comm.delete_message': () => del(apiPath(`/messages/${params.messageId}`)),
  'comm.pin':            () => post(apiPath(`/messages/${params.messageId}/pin`)),
  'comm.unpin':          () => del(apiPath(`/messages/${params.messageId}/pin`)),

  // ⏳ core MISSING — mark-read / typing / search not yet exposed.
  'comm.mark_read': () => post(apiPath(`/conversations/${params.conversationId}/read`), {
    message_id: params.messageId,
  }),
  'comm.typing':    () => post(apiPath(`/conversations/${params.conversationId}/typing`), {
    state: params.state || 'started',
  }),
  'comm.search':    () => get(apiPath('/search'), {
    q:               params.q,
    type:            params.type,
    conversation_id: params.conversationId,
    sender_id:       params.senderId,
    page_size:       params.pageSize ?? params.limit,
    page_token:      params.pageToken ?? params.cursor,
  }),
};

function printUsage() {
  console.log(`Comm CLI — IM operations on cws-core

Usage: node src/cli/comm.js <command> '<json-params>'

Conversations
  ✅ comm.list_conversations   {pageSize?, pageToken?}
  ✅ comm.create_conversation  {type, title?, participantIds?}     # type: dm|group
  ✅ comm.create_dm            {participantId}                     # shortcut for type:dm
  ⏳ comm.get_conversation     {conversationId}                    # pending core

Messages
  ✅ comm.send                 {conversationId, content, replyTo?, clientMsgId?}
                               # content: string | {text|body, markdown?} | {type,body} | [{type,body}]
                               # clientMsgId auto-generated if omitted
  ✅ comm.get_messages         {conversationId, afterSeq?, beforeSeq?, limit?}
  ⏳ comm.edit_message         {messageId, content}                # pending core
  ⏳ comm.delete_message       {messageId}                         # pending core
  ⏳ comm.pin / comm.unpin     {messageId}                         # pending core
  ⏳ comm.mark_read            {conversationId, messageId}         # pending core
  ⏳ comm.typing               {conversationId, state?}            # pending core

Search
  ⏳ comm.search               {q, type?, conversationId?, senderId?, ...}   # pending core

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
