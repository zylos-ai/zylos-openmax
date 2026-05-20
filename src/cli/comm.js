#!/usr/bin/env node

/**
 * Communication CLI — IM REST surface on the cws-core Gateway
 * (/api/gateway/v1/im/*).
 *
 * Day-to-day reactive IM (Agent replying to a user via C4) goes through
 * comm-bridge.js automatically. This CLI is for *proactive* IM ops:
 * starting a new DM, sending into a non-current conversation, searching
 * history, marking read, etc.
 *
 * WebSocket frames (real-time delivery) are NOT handled here — that lives
 * in src/lib/ws.js and stays on the direct cws-comm link.
 *
 * Usage:
 *   node src/cli/comm.js <command> '<json-params>'
 *   node src/cli/comm.js comm.send '{"conversationId":"cv-1","content":{"text":"hi"}}'
 */

import { randomUUID } from 'crypto';
import { get, post, patch, del, apiPath } from '../lib/client.js';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

/**
 * The doc requires `client_message_id` on every send (so the eventual
 * WS echo can be deduped). Auto-fill when caller didn't provide one.
 */
function ensureClientMessageId(id) {
  return id || `cmsg_${randomUUID()}`;
}

/**
 * `content` may arrive as a bare string ("hello") or as the full envelope
 * ({text, format?, mentions?}). Normalize to envelope.
 */
function normalizeContent(c) {
  if (c == null) return { text: '' };
  if (typeof c === 'string') return { text: c };
  return c;
}

const COMMANDS = {
  // Conversation collection
  'comm.list_conversations': () => get(apiPath('/im/conversations'), {
    type:   params.type,      // all|dm|group|b2b
    q:      params.q,
    cursor: params.cursor,
    limit:  params.limit,
  }),
  'comm.get_conversation': () => get(apiPath(`/im/conversations/${params.conversationId}`), {
    include: params.include,
  }),
  'comm.create_conversation': () => post(apiPath('/im/conversations'), {
    type:              params.type,
    name:              params.name,
    member_ids:        params.memberIds,
    agent_1_id:        params.agent1Id,
    agent_2_id:        params.agent2Id,
    trigger:           params.trigger,
    trigger_detail:    params.triggerDetail,
    viewer_member_ids: params.viewerMemberIds,
  }),
  // Helper — DM is just create_conversation with type:"dm"
  'comm.create_dm': () => post(apiPath('/im/conversations'), {
    type:       'dm',
    member_ids: [params.participantId],
  }),

  // Messages
  'comm.get_messages': () => get(apiPath(`/im/conversations/${params.conversationId}/messages`), {
    cursor:    params.cursor,
    limit:     params.limit,
    direction: params.direction,    // before|after
  }),
  'comm.send': () => post(apiPath(`/im/conversations/${params.conversationId}/messages`), {
    client_message_id: ensureClientMessageId(params.clientMessageId),
    message_type:      params.messageType || 'text',
    content:           normalizeContent(params.content),
    attachments:       params.attachments,
    reply_to:          params.replyTo,
  }),
  'comm.edit_message':   () => patch(apiPath(`/im/messages/${params.messageId}`), {
    content: normalizeContent(params.content),
  }),
  'comm.delete_message': () => del(apiPath(`/im/messages/${params.messageId}`)),

  // Pin / mark-read / typing
  'comm.pin':       () => post(apiPath(`/im/messages/${params.messageId}/pin`)),
  'comm.unpin':     () => del(apiPath(`/im/messages/${params.messageId}/pin`)),
  'comm.mark_read': () => post(apiPath(`/im/conversations/${params.conversationId}/read`), {
    message_id: params.messageId,
  }),
  'comm.typing':    () => post(apiPath(`/im/conversations/${params.conversationId}/typing`), {
    state: params.state || 'started',  // started|stopped
  }),

  // Search across IM
  'comm.search': () => get(apiPath('/im/search'), {
    q:               params.q,
    type:            params.type,           // messages|files|links
    conversation_id: params.conversationId,
    sender_id:       params.senderId,
    cursor:          params.cursor,
    limit:           params.limit,
  }),
};

function printUsage() {
  console.log(`Comm CLI — IM operations on the cws-core Gateway

Usage: node src/cli/comm.js <command> '<json-params>'

Conversations
  comm.list_conversations    {type?, q?, cursor?, limit?}                # type: all|dm|group|b2b
  comm.get_conversation      {conversationId, include?}
  comm.create_conversation   {type, name?, memberIds?, agent1Id?, agent2Id?, trigger?, triggerDetail?, viewerMemberIds?}
  comm.create_dm             {participantId}                             # shortcut: create_conversation type:dm

Messages
  comm.send                  {conversationId, content, messageType?, attachments?, replyTo?, clientMessageId?}
                             # content can be a string or {text, format?, mentions?}
                             # clientMessageId auto-generated if omitted
  comm.get_messages          {conversationId, cursor?, limit?, direction?}    # direction: before|after
  comm.edit_message          {messageId, content}
  comm.delete_message        {messageId}                                  # recall / soft-delete
  comm.pin                   {messageId}
  comm.unpin                 {messageId}
  comm.mark_read             {conversationId, messageId}
  comm.typing                {conversationId, state?}                     # state: started|stopped

Search
  comm.search                {q, type?, conversationId?, senderId?, cursor?, limit?}

Environment:
  COCO_API_URL       Gateway base URL (default: http://127.0.0.1:8080).
  COCO_AUTH_TOKEN    Bearer token for authenticated endpoints.
  COCO_API_PREFIX    Path prefix override (default: /api/gateway/v1).

Not yet on the gateway (pending #待确认问题):
  comm.create_thread         # thread spawning from a message — no dedicated endpoint
  comm.add_reaction          # reactions surface (WS event exists; REST shape TBD)
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
