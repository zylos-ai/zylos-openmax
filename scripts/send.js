#!/usr/bin/env node

/**
 * C4 standard outbound interface — directly calls cws-core OpenAPI
 * `POST /api/v1/conversations/{conversation_id}/messages`.
 *
 * Usage:
 *   node scripts/send.js '<endpoint>' '<message>'
 *
 * Endpoint forms (per docs/DESIGN.md §3.4; encoded by C4):
 *   <conversationId>
 *   <conversationId>|reply:<messageId>
 *   <conversationId>|thread:<threadConvId>|parent:<parentMsgId>
 * The legacy `[COCO TYPE]/<conversationId>...` form is still accepted by
 * parseEndpoint for backward compatibility.
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

import fs from 'fs';
import path from 'path';
import { post, apiPath } from '../src/lib/client.js';
import {
  parseEndpoint,
  looksLikeMarkdown,
  parseMediaPrefix,
  newClientMsgId,
  splitMessage,
} from '../src/lib/message.js';
import { uploadMedia } from '../src/cli/as.js';
import { resolveMentions } from '../src/lib/mention.js';
import { lookupConvOrg } from '../src/lib/conv-org.js';
import { RUNTIME_DIR } from '../src/lib/session.js';

const TYPING_DIR = path.join(RUNTIME_DIR, 'typing');

function markTypingDone(messageId) {
  if (!messageId) return;
  const safe = messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
  try {
    fs.mkdirSync(TYPING_DIR, { recursive: true });
    fs.writeFileSync(path.join(TYPING_DIR, `${safe}.done`), String(Date.now()));
  } catch {}
}

function usage() {
  console.error('Usage: node scripts/send.js <endpoint> <message>');
  console.error('');
  console.error('Endpoint format:');
  console.error('  <conversationId>');
  console.error('  <conversationId>|reply:<messageId>');
  console.error('  <conversationId>|thread:<threadId>|parent:<parentMsgId>');
  console.error('  (legacy [COCO TYPE]/<conversationId>... is still accepted)');
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
  // Canonicalize @mentions to the exact participant display_name so cws-fe's
  // participant-name matcher highlights them (cws-fe issue #6 covers the
  // AGENT_TEXT render side). No-op when no known participant matches.
  text = resolveMentions(text, convId);
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

async function sendMediaMessage(ep, kind, localPath, caption) {
  const convId = resolveTargetConversation(ep);
  const messageType = kind === 'image' ? 'IMAGE' : 'FILE';
  const contentType = kind === 'image' ? 'image' : 'file';
  // IM-mode finalize returns BOTH `mediaId` and `artifactId` as *distinct* UUIDs:
  //   - `mediaId`    : cws-comm-internal media reference (lives on the message)
  //   - `artifactId` : cws-as artifact id (the actual blob in storage)
  // The chat message's `attachments[].artifact_id` field must hold the
  // cws-as id so that any consumer (FE / agent) can `as.resolve` it to a
  // download URL. Using `mediaId` instead yields a "image loading…" forever
  // placeholder because cws-as has no record of that id. See group thread
  // 2026-06-04 22:24 HKT for the cross-agent investigation.
  // uploadMedia returns the resolved MIME under `mimeType`; older shapes used
  // `contentType`. Read `mimeType` first and fall back to `contentType` so the
  // attachment's content_type isn't dropped (issue #8) — otherwise the
  // outbound message ships an empty MIME and the FE can't render the image.
  const { mediaId, artifactId, fileName, mimeType, contentType: legacyContentType, sizeBytes } = await uploadMedia(localPath, {
    conversationId: convId,
    mediaType: contentType,
  });
  const mediaContentType = mimeType || legacyContentType || '';
  return post(apiPath(`/conversations/${convId}/messages`), {
    client_msg_id: newClientMsgId(),
    type:          messageType,
    content: {
      content_type: contentType,
      // cws-fe renders the file/image card and caption from content.body
      // ({file_name, text}); an empty body shows a blank bubble. Match the
      // shape the web client itself sends (chat/page.tsx) so attachments and
      // the caption render. Sending body:{} here was the blank-bubble bug.
      body:         { file_name: fileName || '', ...(caption ? { text: caption } : {}) },
      attachments: [{
        artifact_id:  artifactId || mediaId,    // prefer the cws-as artifact id; fall back to media id only for backward-compat
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

  // Smart-mode escape hatch: when formatInboundForC4 emits a <smart-mode>
  // block, the LLM may decide to stay silent by replying with the literal
  // string "[SKIP]". Treat that as a no-op so we don't actually post it.
  // Mirrors zylos-feishu/scripts/send.js:64.
  if (message.trim() === '[SKIP]') {
    console.log(JSON.stringify({ ok: true, skipped: true }));
    return;
  }

  let ep;
  try {
    ep = parseEndpoint(endpoint);
  } catch (e) {
    console.error(JSON.stringify({ error: e.message }));
    process.exit(1);
  }

  // Multi-org: resolve the conversation's org so downstream API calls use
  // the correct org-scoped JWT. Without this, resolveDefaultOrgId() returns
  // empty when 2+ orgs are enabled, producing an identity-only token → 401.
  if (!process.env.COCO_ORG_ID) {
    const convId = ep.threadConversationId || ep.conversationId;
    const orgId = lookupConvOrg(convId);
    if (orgId) process.env.COCO_ORG_ID = orgId;
  }

  try {
    const media = parseMediaPrefix(message);
    const result = media
      ? await sendMediaMessage(ep, media.kind, media.localPath, media.caption)
      : await sendText(ep, message);
    markTypingDone(ep.replyTo || ep.conversationId);
    console.log(JSON.stringify(result));
  } catch (e) {
    const payload = { error: e.message };
    if (e.status) payload.status = e.status;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

main();
