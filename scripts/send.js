#!/usr/bin/env node

/**
 * C4 standard outbound interface — aligned with cws-comm api-design.md §5.1.
 *
 * Usage:
 *   node scripts/send.js '<endpoint>' '<message>'
 *
 * Endpoint forms (per api-design.md §5; mirrored into our C4 routing):
 *   [COCO DM]/<conversationId>
 *   [COCO GROUP]/<conversationId>|reply:<messageId>
 *   [COCO THREAD]/<conversationId>|thread:<threadId>|parent:<parentMsgId>
 *
 * Message body forms:
 *   plain text         → type=text,   content={text, version:1}
 *   markdown-looking   → type=text,   content={text, version:1, markdown:true}  (heuristic)
 *   [MEDIA:image]/path → upload via /api/v1/media/upload then type=image
 *   [MEDIA:file]/path  → upload via /api/v1/media/upload then type=file
 *
 * Auth resolution:
 *   1. session_token  (~/zylos/components/coco-workspace/runtime/session.json, written by comm-bridge)
 *   2. COCO_AUTH_TOKEN env (API key fallback, degraded mode)
 *
 * Required config.workspace_id (for X-Workspace-Id header).
 */

import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

import { post } from '../src/lib/client.js';
import {
  parseEndpoint,
  looksLikeMarkdown,
  parseMediaPrefix,
  newClientMsgId,
} from '../src/lib/message.js';
import { uploadMedia } from '../src/lib/media.js';

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

async function sendText(conversationId, ep, text) {
  const content = { text, version: 1 };
  if (looksLikeMarkdown(text)) content.markdown = true;
  return post('/api/v1/messages', {
    conversation_id: conversationId,
    client_msg_id:   newClientMsgId(),
    type:            'text',
    content,
    thread_id:       ep.threadConversationId,
    reply_to:        ep.replyTo,
    parent_message_id: ep.parentMessageId,
  });
}

async function sendMediaMessage(conversationId, ep, kind, localPath) {
  const mediaType = kind === 'image' ? 'image' : 'file';
  const { mediaId, fileName, mimeType, size } = await uploadMedia(localPath, {
    conversationId,
    mediaType,
  });
  return post('/api/v1/messages', {
    conversation_id: conversationId,
    client_msg_id:   newClientMsgId(),
    type:            mediaType,
    content: {
      media_id:  mediaId,
      filename:  fileName,
      mime_type: mimeType,
      size,
      version:   1,
    },
    thread_id:       ep.threadConversationId,
    reply_to:        ep.replyTo,
    parent_message_id: ep.parentMessageId,
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
  // When a thread is targeted, the message belongs to the *root*
  // conversation_id with thread_id set (cws-comm §5.1 SendMessageRequest).
  const conversationId = ep.conversationId;

  try {
    const media = parseMediaPrefix(message);
    const result = media
      ? await sendMediaMessage(conversationId, ep, media.kind, media.localPath)
      : await sendText(conversationId, ep, message);
    console.log(JSON.stringify(result));
  } catch (e) {
    const payload = { error: e.message };
    if (e.status) payload.status = e.status;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
