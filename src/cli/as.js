#!/usr/bin/env node

/**
 * ArtifactStore CLI.
 *
 * Wraps file/attachment endpoints exposed by the cws-core Gateway. Note that
 * "Artifact" in COCO is not a single REST namespace; attachments live in two
 * scopes:
 *
 *   - IM attachments  → /api/gateway/v1/im/uploads/{presign,{id}/complete}
 *   - KB files        → /api/gateway/v1/knowledge-bases/{kbId}/files
 *
 * IM upload is two-step: presign → PUT bytes to signed URL → complete.
 * KB upload is one-step multipart.
 *
 * Usage:
 *   node src/cli/as.js <command> '<json-params>'
 *   node src/cli/as.js as.upload_im '{"conversationId":"cv-1","filePath":"/tmp/x.png"}'
 *   node src/cli/as.js as.upload_kb '{"kbId":"kb-1","filePath":"/tmp/report.pdf","parentId":"nd-deliv"}'
 */

import { post, apiPath, upload as uploadMultipart } from '../lib/client.js';
import fs from 'fs';
import path from 'path';

const [command, ...rest] = process.argv.slice(2);
const params = rest.length ? JSON.parse(rest.join(' ')) : {};

// ---- IM attachment helpers ---------------------------------------------------

async function imPresign({ conversationId, files }) {
  return post(apiPath('/im/uploads/presign'), {
    conversation_id: conversationId,
    files,
  });
}

async function imComplete(uploadId) {
  return post(apiPath(`/im/uploads/${uploadId}/complete`));
}

/**
 * PUT raw bytes to the signed URL returned by presign. Server-issued headers
 * (Content-Type, x-amz-* etc.) are preserved as-is.
 */
async function putBytes(putUrl, buf, mime, extraHeaders = {}) {
  const headers = { 'Content-Type': mime || 'application/octet-stream', ...extraHeaders };
  const res = await fetch(putUrl, { method: 'PUT', headers, body: buf });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`PUT ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    throw err;
  }
  return { ok: true, status: res.status };
}

function readFile(filePath) {
  const buf  = fs.readFileSync(filePath);
  const name = path.basename(filePath);
  return { buf, name };
}

const COMMANDS = {
  // ---- IM attachment ---------------------------------------------------------
  // Two-step. Use as.upload_im for the full flow; as.presign / as.complete for
  // callers that want to manage the PUT themselves.
  'as.presign':  () => imPresign({
    conversationId: params.conversationId,
    files:          params.files,    // [{name, mime_type, size}]
  }),
  'as.complete': () => imComplete(params.uploadId),

  'as.upload_im': async () => {
    if (!params.conversationId) throw new Error('conversationId is required');
    if (!params.filePath)       throw new Error('filePath is required');
    const { buf, name } = readFile(params.filePath);
    const mime = params.contentType || 'application/octet-stream';
    const presigned = await imPresign({
      conversationId: params.conversationId,
      files: [{ name: params.filename || name, mime_type: mime, size: buf.length }],
    });
    // Tolerate response shape variations: {data:{uploads:[{upload_id,put_url}]}}
    // or {uploads:[...]} or [{...}] at top.
    const entry =
      presigned?.data?.uploads?.[0] ??
      presigned?.uploads?.[0] ??
      (Array.isArray(presigned) ? presigned[0] : presigned);
    if (!entry?.put_url || !entry?.upload_id) {
      throw new Error('presign response missing put_url/upload_id; raw=' + JSON.stringify(presigned));
    }
    await putBytes(entry.put_url, buf, mime, entry.headers || {});
    return imComplete(entry.upload_id);
  },

  // ---- KB file upload --------------------------------------------------------
  // Single-step multipart. Same effect as `kb.upload` — kept here so AS-flow
  // callers don't need to know about the KB CLI module boundary.
  'as.upload_kb': () => {
    if (!params.kbId)     throw new Error('kbId is required');
    if (!params.filePath) throw new Error('filePath is required');
    const { buf, name } = readFile(params.filePath);
    return uploadMultipart(apiPath(`/knowledge-bases/${params.kbId}/files`), {
      file: buf,
      name: params.filename || name,
      mime: params.contentType,
      fields: {
        parent_id: params.parentId,
        title:     params.title,
      },
    });
  },
};

function printUsage() {
  console.log(`AS CLI — ArtifactStore for COCO agents

Usage: node src/cli/as.js <command> '<json-params>'

IM attachment (two-step: presign → PUT → complete)
  as.upload_im     {conversationId, filePath, filename?, contentType?}   # full flow
  as.presign       {conversationId, files:[{name,mime_type,size}]}       # step 1 only
  as.complete      {uploadId}                                            # step 3 only

KB file (one-step multipart)
  as.upload_kb     {kbId, filePath, filename?, contentType?, parentId?, title?}
                   # equivalent to kb.upload — exposed here for AS-centric callers

Environment:
  COCO_API_URL       Gateway base URL (default: http://127.0.0.1:8080).
  COCO_AUTH_TOKEN    Bearer token for authenticated endpoints.
  COCO_API_PREFIX    Path prefix override (default: /api/gateway/v1).

Not yet stabilized by the gateway (pending #待确认问题):
  as.get             # fetch artifact metadata by id
  as.url             # mint a short-lived signed read URL
  as.list            # enumerate artifacts attached to an issue/project
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
