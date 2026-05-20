#!/usr/bin/env node

/**
 * ArtifactStore — canonical interface for all file upload / download in
 * zylos-coco-workspace.
 *
 * Two roles in one file:
 *
 *   1. **Library exports** (imported by scripts/send.js and src/comm-bridge.js):
 *        - uploadMedia(localPath, opts)   — IM/KB attachment upload
 *        - downloadMedia(url, filename)   — fetch bytes from a signed URL
 *        - getMediaUrl(mediaId)           — mint a download URL for media_id
 *      Everything that touches media bytes goes through these functions, so
 *      there is exactly one implementation per operation.
 *
 *   2. **CLI dispatcher** (when invoked as `node src/cli/as.js <cmd> '<json>'`):
 *        - as.upload     — generic media upload, wraps uploadMedia()
 *        - as.url        — wraps getMediaUrl()
 *        - as.download   — wraps downloadMedia(), saves to local temp
 *      The CLI dispatcher only runs when this file is the entry point
 *      (see the `import.meta.url === ...` guard at the bottom).
 *
 * Endpoint backing (per cws-comm api-design.md §5.8 — cws-core does not
 * yet expose these in its OpenAPI; calls 404 until core adds them):
 *
 *     POST /api/v1/media/upload       → { media_id, upload_url, upload_headers }
 *     PUT  <upload_url>               ← raw bytes (S3-style direct upload)
 *     GET  /api/v1/media/{id}/url     → { url, expires_at }
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { get, post, apiPath } from '../lib/client.js';

const HOME = process.env.HOME || '/tmp';
const TMP_DIR = path.join(HOME, 'zylos/components/coco-workspace/media');

const MIME_BY_KIND = {
  image:   'image/png',
  video:   'video/mp4',
  audio:   'audio/mpeg',
  voice:   'audio/ogg',
  file:    'application/octet-stream',
  sticker: 'image/webp',
};

async function ensureTmpDir() {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
}

// ============================================================================
//  Library functions (also used by scripts/send.js, src/comm-bridge.js)
// ============================================================================

/**
 * Upload a local file to cws-core's media endpoint and return the
 * server-assigned media_id.
 *
 *   1. POST /api/v1/media/upload with file metadata → { media_id, upload_url, upload_headers }
 *   2. PUT the raw bytes to upload_url (typically a signed S3 URL)
 *
 * @param {string} localPath
 * @param {object} opts
 * @param {string} opts.conversationId  required (access-control scoping)
 * @param {string} [opts.mediaType]     image|video|audio|voice|file|sticker (default 'file')
 * @param {string} [opts.mimeType]      explicit MIME; inferred from mediaType otherwise
 * @returns {Promise<{mediaId:string, mediaType:string, mimeType:string, size:number, fileName:string}>}
 */
export async function uploadMedia(localPath, opts = {}) {
  if (!localPath) throw new Error('uploadMedia: localPath is required');
  if (!opts.conversationId) {
    throw new Error('uploadMedia: opts.conversationId is required for access scoping');
  }
  const stat = await fs.promises.stat(localPath);
  const mediaType = opts.mediaType || 'file';
  const mimeType  = opts.mimeType || MIME_BY_KIND[mediaType] || 'application/octet-stream';
  const fileName  = path.basename(localPath);

  const init = await post(apiPath('/media/upload'), {
    file_name:       fileName,
    mime_type:       mimeType,
    file_size:       stat.size,
    conversation_id: opts.conversationId,
    media_type:      mediaType,
  });
  const { media_id: mediaId, upload_url: uploadUrl, upload_headers: uploadHeaders } = init || {};
  if (!mediaId || !uploadUrl) {
    throw new Error('cws-core /media/upload returned no media_id/upload_url');
  }

  const data = await fs.promises.readFile(localPath);
  const r = await fetch(uploadUrl, {
    method:  'PUT',
    body:    data,
    headers: { 'Content-Type': mimeType, ...(uploadHeaders || {}) },
  });
  if (!r.ok) throw new Error(`media PUT failed: HTTP ${r.status}`);

  return { mediaId, mediaType, mimeType, size: stat.size, fileName };
}

/**
 * Get a (typically signed) download URL for a media_id. Inbound message
 * frames carry media_id only; this turns it into a fetchable URL.
 *
 * @param {string} mediaId
 * @returns {Promise<{url:string, expiresAt?:string}>}
 */
export async function getMediaUrl(mediaId) {
  if (!mediaId) throw new Error('getMediaUrl: mediaId is required');
  const meta = await get(apiPath(`/media/${mediaId}/url`));
  const url = meta?.url || meta?.signed_url || meta?.download_url;
  if (!url) throw new Error('cws-core /media/{id}/url returned no url');
  return { url, expiresAt: meta?.expires_at || meta?.expiresAt };
}

/**
 * Download bytes from a (typically signed) URL into the component's
 * temp media directory. Returns the absolute local path.
 *
 * @param {string} url
 * @param {string} [filename]
 * @returns {Promise<string>} absolute local path
 */
export async function downloadMedia(url, filename) {
  if (!url) throw new Error('downloadMedia: url is required');
  await ensureTmpDir();
  const safeName = (filename || `media-${Date.now()}`).replace(/[/\\]/g, '_');
  const localPath = path.join(TMP_DIR, safeName);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.promises.writeFile(localPath, buf);
  return localPath;
}

// ============================================================================
//  CLI dispatcher (only when this file is the entry point)
// ============================================================================

const COMMANDS = {
  // Upload a local file to a conversation.
  // Returns: {mediaId, mediaType, mimeType, size, fileName}
  'as.upload': async (params) => {
    if (!params.filePath)       throw new Error('filePath is required');
    if (!params.conversationId) throw new Error('conversationId is required');
    return uploadMedia(params.filePath, {
      conversationId: params.conversationId,
      mediaType:      params.mediaType,
      mimeType:       params.contentType,
    });
  },

  // Get a signed download URL for a media_id.
  // Returns: {url, expiresAt?}
  'as.url': async (params) => {
    if (!params.mediaId) throw new Error('mediaId is required');
    return getMediaUrl(params.mediaId);
  },

  // Download a media_id to a local file. Pulls fresh URL + bytes.
  // Returns: {localPath}
  'as.download': async (params) => {
    if (!params.mediaId) throw new Error('mediaId is required');
    const { url } = await getMediaUrl(params.mediaId);
    const localPath = await downloadMedia(url, params.filename);
    return { localPath };
  },
};

function printUsage() {
  console.log(`AS CLI — ArtifactStore for COCO agents

Usage: node src/cli/as.js <command> '<json-params>'

Commands
  as.upload      {conversationId, filePath, mediaType?, contentType?}
                 # mediaType: image|video|audio|voice|file|sticker (default file)
                 # → {mediaId, mediaType, mimeType, size, fileName}

  as.url         {mediaId}
                 # → {url, expiresAt}

  as.download    {mediaId, filename?}
                 # → {localPath}

Environment:
  COCO_API_URL       Gateway base URL (default: http://127.0.0.1:8080)
  COCO_AUTH_TOKEN    Bearer token for authenticated endpoints
  COCO_API_PREFIX    Path prefix override (default: /api/v1)

Pending cws-core support (calls 404 today):
  POST /api/v1/media/upload    — referenced by as.upload
  GET  /api/v1/media/{id}/url  — referenced by as.url / as.download
`);
}

async function runCli() {
  const [command, ...rest] = process.argv.slice(2);
  const params = rest.length ? JSON.parse(rest.join(' ')) : {};

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
    const result = await handler(params);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    const payload = { error: err.message };
    if (err.status) payload.status = err.status;
    console.error(JSON.stringify(payload));
    process.exit(1);
  }
}

// Run the CLI dispatcher only when invoked as a script (`node src/cli/as.js ...`),
// not when imported as a module (`import { uploadMedia } from '.../as.js'`).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
