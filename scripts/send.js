#!/usr/bin/env node

/**
 * C4 standard outbound interface — directly calls cws-core OpenAPI
 * `POST /api/v1/conversations/{conversation_id}/messages`.
 *
 * Usage:
 *   node scripts/send.js '<endpoint>' '<message>'
 *
 * Endpoint forms (per docs/DESIGN.md §3.4; encoded by C4):
 *   [COCO DM]/<conversationId>
 *   [COCO GROUP]/<conversationId>|reply:<messageId>
 *   [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * Message body forms:
 *   plain text         → content=[{type:"text", body:<text>}]
 *   markdown-looking   → content=[{type:"markdown", body:<text>}]   (heuristic)
 *   [MEDIA:image]/path → upload via as.js → content=[{type:"image", body:<media_id>}]
 *   [MEDIA:file]/path  → upload via as.js → content=[{type:"file",  body:<media_id>}]
 *
 * Long text is split into ≤3000-char chunks (paragraph → newline → hard) and
 * sent as sequential POSTs to the same conversation. Each chunk gets its own
 * client_msg_id so the server de-dupes them independently. `reply_to` is
 * applied only on the first chunk to avoid duplicate threading.
 *
 * cws-core SendMessageRequestBody (current schema, per
 * internal/transport/http/message.go:sendMessageRequest):
 *   { client_msg_id, type, content: MessageContentItem, parent_id?,
 *     thread_id?, ttl?, metadata? }
 *   type: enum UNSPECIFIED|TEXT|IMAGE|FILE|AUDIO|VIDEO|SYSTEM|AGENT_TEXT|
 *     AGENT_STRUCTURED|AGENT_CARD|AGENT_STREAM
 *   MessageContentItem: { content_type, body: object, attachments: [] }
 *
 * Auth: Bearer api_key (canonical store: config.agent.api_key) plus
 *       X-Workspace-Id header (handled by client.js).
 */

import { post, apiPath } from '../src/lib/client.js';
import {
  parseEndpoint,
  looksLikeMarkdown,
  parseMediaPrefix,
  newClientMsgId,
  splitMessage,
} from '../src/lib/message.js';
import { uploadMedia } from '../src/cli/as.js';

function usage() {
  console.error('Usage: node scripts/send.js <endpoint> <message>');
  console.error('');
  console.error('Endpoint format:');
  console.error('  [COCO DM]/<conversationId>');
  console.error('  [COCO GROUP]/<conversationId>|reply:<messageId>');
  console.error('  [COCO THREAD]/<conversationId>|thread:<threadId>|parent:<parentMsgId>');
  console.error('');
  console.error('Message: plain text, markdown (auto-detected), or [MEDIA:image|file]/abs/path');
}

/**
 * Pick the conversation_id the message actually targets. For a thread
 * endpoint, the thread is its own conversation so we send to it; for
 * DM/group, we send to the parent conversation. reply_to is the only
 * field cws-core's SendMessageRequestBody supports for in-context
 * replies (thread parent_message_id is not in the schema).
 */
function resolveTargetConversation(ep) {
  return ep.threadConversationId || ep.conversationId;
}

async function sendText(ep, text) {
  const convId = resolveTargetConversation(ep);
  const chunks = splitMessage(text);
  const results = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const contentType = looksLikeMarkdown(chunk) ? 'markdown' : 'text';
    // cws-core SendMessageRequest body (current schema):
    //   { client_msg_id, type, content: {content_type, body, attachments}, parent_id? }
    // type is the message-level enum (AGENT_TEXT for agent outbound text /
    // markdown); content.content_type is the body serialization
    // ('text' | 'markdown' | ...). attachments is required (may be empty).
    const body = {
      client_msg_id: newClientMsgId(),
      type:          'AGENT_TEXT',
      content: {
        content_type: contentType,
        body:         { text: chunk },
        attachments:  [],
      },
      // parent_id only on the first chunk to avoid duplicate threading
      ...(i === 0 && ep.replyTo ? { parent_id: ep.replyTo } : {}),
    };
    // eslint-disable-next-line no-await-in-loop
    const res = await post(apiPath(`/conversations/${convId}/messages`), body);
    results.push(res?.id || res?.message_id || null);
  }
  return { ok: true, chunks: chunks.length, message_ids: results };
}

async function sendMediaMessage(ep, kind, localPath) {
  const convId = resolveTargetConversation(ep);
  const messageType = kind === 'image' ? 'IMAGE' : 'FILE';
  const contentType = kind === 'image' ? 'image' : 'file';
  const { mediaId, fileName, contentType: mediaContentType, sizeBytes } = await uploadMedia(localPath, {
    conversationId: convId,
    mediaType: contentType,
  });
  // Media references go in `attachments`, not the body. cws-core's
  // attachmentItem expects {artifact_id, file_name, content_type, size_bytes};
  // `mediaId` returned from cws-as upload is the canonical artifact_id.
  return post(apiPath(`/conversations/${convId}/messages`), {
    client_msg_id: newClientMsgId(),
    type:          messageType,
    content: {
      content_type: contentType,
      body:         {},
      attachments: [{
        artifact_id:  mediaId,
        file_name:    fileName || '',
        content_type: mediaContentType || '',
        size_bytes:   sizeBytes || 0,
      }],
    },
    ...(ep.replyTo ? { parent_id: ep.replyTo } : {}),
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) { usage(); process.exit(1); }

  const [endpoint, ...messageParts] = args;
  const message = messageParts.join(' ');

  let ep;
  try {
    ep = parseEndpoint(endpoint);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }

  try {
    const media = parseMediaPrefix(message);
    const result = media
      ? await sendMediaMessage(ep, media.kind, media.localPath)
      : await sendText(ep, message);
    console.log(JSON.stringify(result));
  } catch (e) {
    const payload = { error: e.message };
    if (e.status) payload.status = e.status;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
