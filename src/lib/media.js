/**
 * Media file handling.
 *
 * Inbound:  download attachment bytes referenced in an incoming
 *           message frame → local temp file, the path is then embedded
 *           into the C4 inbound text so the Agent can read it directly.
 *
 * Outbound: upload local file via cws-comm `/api/v1/media/upload`
 *           (api-design.md §5.8). cws-comm delegates storage to AS and
 *           returns `{media_id, upload_url, upload_headers, expires_at}`.
 *           The caller then PUTs the bytes to `upload_url` with the
 *           returned headers. No separate finalize step.
 *
 * The returned `media_id` is what messages reference in
 * `content.media_id`, not an `artifact://` URI (AS internals are hidden
 * behind cws-comm).
 */

import fs from 'fs';
import path from 'path';
import { post } from './client.js';

const HOME = process.env.HOME || '/tmp';
const TMP_DIR = path.join(HOME, 'zylos/components/coco-workspace/media');

async function ensureTmpDir() {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
}

/**
 * Download a media file from a (typically pre-signed) URL provided by
 * cws-comm in the incoming message frame.
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

const MIME_BY_KIND = {
  image: 'image/png',
  video: 'video/mp4',
  audio: 'audio/mpeg',
  voice: 'audio/ogg',
  file:  'application/octet-stream',
  sticker: 'image/webp',
};

/**
 * Upload a local file via cws-comm's media endpoint and return the
 * server-assigned media_id.
 *
 * @param {string} localPath
 * @param {object} opts
 * @param {string} opts.conversationId  required (access-control scoping)
 * @param {string} [opts.mediaType]     image|video|audio|voice|file|sticker (default file)
 * @param {string} [opts.mimeType]      explicit MIME; inferred from mediaType otherwise
 * @returns {Promise<{mediaId:string, mediaType:string, mimeType:string, size:number}>}
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

  const init = await post('/api/v1/media/upload', {
    file_name:       fileName,
    mime_type:       mimeType,
    file_size:       stat.size,
    conversation_id: opts.conversationId,
    media_type:      mediaType,
  });
  const { media_id: mediaId, upload_url: uploadUrl, upload_headers: uploadHeaders } = init || {};
  if (!mediaId || !uploadUrl) {
    throw new Error('cws-comm /media/upload returned no media_id/upload_url');
  }

  const data = await fs.promises.readFile(localPath);
  const r = await fetch(uploadUrl, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': mimeType, ...(uploadHeaders || {}) },
  });
  if (!r.ok) throw new Error(`media PUT failed: HTTP ${r.status}`);

  return { mediaId, mediaType, mimeType, size: stat.size, fileName };
}
