#!/usr/bin/env node

/**
 * C4 standard outbound interface (DESIGN.md §3.3).
 *
 * Usage:
 *   node scripts/send.js '<endpoint>' '<message>'
 *
 * Endpoint forms (per DESIGN.md §3.4):
 *   [COCO DM]/<conversationId>
 *   [COCO GROUP]/<conversationId>|reply:<messageId>
 *   [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 *
 * Message body forms:
 *   plain text         → sent as type=text
 *   markdown-looking   → sent as type=text with markdown=true (heuristic)
 *   [MEDIA:image]/path → upload to AS first, send as type=image
 *   [MEDIA:file]/path  → upload to AS first, send as type=file
 *
 * Output: success → JSON to stdout, exit 0; failure → JSON error to stderr, exit 1.
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config({ path: path.join(process.env.HOME || '', 'zylos/.env') });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { post } from '../src/lib/client.js';
import { parseEndpoint, looksLikeMarkdown, parseMediaPrefix } from '../src/lib/message.js';
import { uploadToAS } from '../src/lib/media.js';

function usage() {
  console.error('Usage: node scripts/send.js <endpoint> <message>');
  console.error('');
  console.error('Endpoint format:');
  console.error('  [COCO DM]/<conversationId>');
  console.error('  [COCO GROUP]/<conversationId>|reply:<messageId>');
  console.error('  [COCO THREAD]/<conversationId>|thread:<threadConvId>|parent:<parentMsgId>');
  console.error('');
  console.error('Message forms: plain text, markdown, or [MEDIA:image|file]/abs/path');
}

async function sendText(conversationId, ep, text) {
  const payload = {
    type: 'text',
    content: { text, markdown: looksLikeMarkdown(text) },
    reply_to:          ep.replyTo,
    parent_message_id: ep.parentMessageId,
  };
  return post(`/api/conversations/${conversationId}/messages`, payload);
}

async function sendMedia(conversationId, ep, kind, localPath) {
  const contentType = kind === 'image' ? 'image/*' : 'application/octet-stream';
  const artifactUri = await uploadToAS(localPath, { contentType });
  const payload = {
    type: kind,
    content: {
      artifact_uri: artifactUri,
      filename: path.basename(localPath),
    },
    reply_to:          ep.replyTo,
    parent_message_id: ep.parentMessageId,
  };
  return post(`/api/conversations/${conversationId}/messages`, payload);
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
  // In thread routing, conversationId points to thread sub-conversation;
  // see DESIGN.md §3.4. Fall back to the main conversationId for DM/group.
  const conversationId = ep.threadConversationId || ep.conversationId;

  try {
    const media = parseMediaPrefix(message);
    const result = media
      ? await sendMedia(conversationId, ep, media.kind, media.localPath)
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
