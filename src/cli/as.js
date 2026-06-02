#!/usr/bin/env node

/**
 * ArtifactStore — canonical interface for all file upload / download in
 * zylos-coco-workspace. Talks to cws-core (contract-v5).
 *
 * v5 collapsed the old cws-as endpoints. The only artifact API that
 * remains is:
 *
 *   POST /api/v1/artifacts/resolve   batch-resolve artifact:// URIs
 *                                     → presigned download URLs
 *
 * Uploads moved to two new namespaces depending on use case:
 *
 *   IM media (attach to a conversation message):
 *     POST /api/v1/conversations/{cid}/uploads/prepare
 *          body {filename, content_type, size_bytes}
 *          resp {upload_token, upload_url, headers, expires_at, instant_upload}
 *     PUT  <upload_url>          (skip if instant_upload)
 *     POST /api/v1/conversations/uploads/finalize
 *          body {upload_token}
 *          resp {media_id, artifact_id}
 *
 *   KB files (attach to a KB tree as a file node):
 *     POST /api/v1/uploads/prepare
 *          body {parent_id?, filename, content_type, size_bytes}
 *          resp {upload_token, upload_url, headers, expires_at, instant_upload}
 *     PUT  <upload_url>          (skip if instant_upload)
 *     POST /api/v1/uploads/finalize
 *          body {upload_token}
 *          resp <tree_node>      (the new file node with its artifact_id)
 *
 * Two roles in one file:
 *
 *   1. Library exports (imported by scripts/send.js, src/comm-bridge.js,
 *      src/cli/kb.js):
 *        - uploadMedia(localPath, opts)   — IM if conversationId, else KB
 *        - downloadMedia(uriOrId, file?)  — fetch bytes from artifact://<id>
 *        - getMediaUrl(uriOrId)           — resolve artifact://<id> → URL
 *        - resolveUris(uris)              — batch /artifacts/resolve
 *
 *   2. CLI dispatcher (when invoked as
 *      `node src/cli/as.js <cmd> '<json>'`):
 *        - as.upload     {filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}
 *        - as.url        {artifactId|uri}
 *        - as.download   {artifactId|uri, filename?}
 *        - as.resolve    {uris, inline?}
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { post, apiPath, putBytes, getBytes } from '../lib/client.js';

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
//  Library functions
// ============================================================================

/**
 * Build an `artifact://` URI from a bare id, or return as-is if already a URI.
 */
function toArtifactUri(idOrUri) {
  if (typeof idOrUri !== 'string') {
    throw new Error('artifact id or URI is required');
  }
  return idOrUri.startsWith('artifact://') ? idOrUri : `artifact://${idOrUri}`;
}

/**
 * Upload a local file via the v5 prepare/finalize flow.
 *
 * Routing:
 *   - `opts.conversationId` set      → IM upload (conversation-scoped)
 *   - `opts.kbId` set or neither     → KB upload (file node in a tree)
 *
 * Backward-compatible return shape: `{mediaId, artifactId, fileName, mimeType,
 * sizeBytes, instantUpload}` so existing callers in send.js / comm-bridge keep
 * working. KB uploads additionally include `{nodeId, treeNode}`.
 */
export async function uploadMedia(localPath, opts = {}) {
  if (!localPath) throw new Error('uploadMedia: localPath is required');
  const buf  = await fs.promises.readFile(localPath);
  const stat = await fs.promises.stat(localPath);

  const fileName    = opts.filename || path.basename(localPath);
  const mediaType   = opts.mediaType || 'file';
  const contentType = opts.mimeType
    || opts.contentType
    || MIME_BY_KIND[mediaType]
    || 'application/octet-stream';
  const sizeBytes = stat.size;

  const isIm = !!opts.conversationId;

  const prepPath = isIm
    ? `/conversations/${opts.conversationId}/uploads/prepare`
    : '/uploads/prepare';

  const prepBody = isIm
    ? { filename: fileName, content_type: contentType, size_bytes: sizeBytes }
    : { parent_id: opts.parentId, filename: fileName, content_type: contentType, size_bytes: sizeBytes };

  const prep = await post(apiPath(prepPath), prepBody);

  const uploadToken   = prep?.upload_token;
  const uploadUrl     = prep?.upload_url;
  const reqHeaders    = prep?.headers || {};
  const instantUpload = prep?.instant_upload === true;

  if (!uploadToken) {
    throw new Error('uploads/prepare returned no upload_token');
  }

  // Step 2: PUT bytes to the pre-signed URL (skip on instant_upload).
  if (!instantUpload) {
    if (!uploadUrl) throw new Error('uploads/prepare returned no upload_url');
    await putBytes(uploadUrl, buf, contentType, reqHeaders);
  }

  // Step 3: finalize.
  const finalizePath = isIm
    ? '/conversations/uploads/finalize'
    : '/uploads/finalize';
  const finalized = await post(apiPath(finalizePath), { upload_token: uploadToken });

  if (isIm) {
    // finalized: {media_id, artifact_id}
    return {
      mediaId:       finalized?.media_id,
      artifactId:    finalized?.artifact_id,
      fileName,
      mimeType:      contentType,
      sizeBytes,
      instantUpload,
    };
  }

  // KB upload: finalized is a tree node (id, kb_id, parent_id, name,
  // artifact_id, ...).
  return {
    mediaId:       finalized?.artifact_id,
    artifactId:    finalized?.artifact_id,
    nodeId:        finalized?.id,
    treeNode:      finalized,
    fileName:      finalized?.name || fileName,
    mimeType:      contentType,
    sizeBytes,
    instantUpload,
  };
}

/**
 * Resolve one artifact id or URI to a presigned URL.
 *
 *   getMediaUrl('artifact://abc-123')     → {url, expiresAt, contentType, name, sizeBytes}
 *   getMediaUrl('abc-123', { inline:1 })  → same, inline disposition
 */
export async function getMediaUrl(idOrUri, opts = {}) {
  const uri = toArtifactUri(idOrUri);
  const inline = opts.inline === true || opts.mode === 'preview';
  const res = await post(apiPath('/artifacts/resolve'), { uris: [uri], inline });
  const entry = res?.resolved?.[uri];
  if (!entry || !entry.download_url) {
    const failed = res?.failed || [];
    const reason = failed.includes(uri) ? 'artifact not resolvable' : 'no download_url in response';
    throw new Error(`getMediaUrl: ${reason} (${uri})`);
  }
  return {
    url:           entry.download_url,
    expiresAt:     entry.expires_at,
    contentType:   entry.content_type,
    contentLength: entry.content_length,
    name:          entry.name,
  };
}

/**
 * Batch-resolve `artifact://` URIs to short-lived download URLs.
 */
export async function resolveUris(uris, opts = {}) {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new Error('resolveUris: uris must be a non-empty array');
  }
  return post(apiPath('/artifacts/resolve'), {
    uris,
    inline: opts.inline === true,
  });
}

/**
 * Download an artifact's bytes to a local file under the component's media
 * tmp dir. Returns the absolute local path.
 *
 *   await downloadMedia('https://...presigned...', 'cat.png')        → uses URL directly
 *   await downloadMedia('artifact://abc-123', 'cat.png')             → resolves first
 *   await downloadMedia('abc-123', 'cat.png')                        → resolves first
 */
export async function downloadMedia(urlOrIdOrUri, filename) {
  let url = urlOrIdOrUri;
  let resolvedName;
  if (!/^https?:\/\//i.test(urlOrIdOrUri)) {
    const meta = await getMediaUrl(urlOrIdOrUri);
    url = meta.url;
    resolvedName = meta.name;
  }
  await ensureTmpDir();
  const safeName = (filename || resolvedName || `media-${Date.now()}`).replace(/[/\\]/g, '_');
  const localPath = path.join(TMP_DIR, safeName);
  const buf = await getBytes(url);
  await fs.promises.writeFile(localPath, buf);
  return localPath;
}

// ============================================================================
//  CLI dispatcher
// ============================================================================

const COMMANDS = {
  // IM mode  : pass conversationId
  // KB mode  : pass parentId (or nothing — defaults to KB root)
  'as.upload': async (params) => {
    if (!params.filePath) throw new Error('filePath is required');
    return uploadMedia(params.filePath, {
      conversationId: params.conversationId,
      parentId:       params.parentId,
      mediaType:      params.mediaType,
      mimeType:       params.contentType,
      filename:       params.filename,
    });
  },

  'as.url': async (params) => {
    const id = params.uri || params.artifactId;
    if (!id) throw new Error('artifactId or uri is required');
    return getMediaUrl(id, { inline: params.inline === true });
  },

  'as.download': async (params) => {
    const id = params.uri || params.artifactId;
    if (!id) throw new Error('artifactId or uri is required');
    const localPath = await downloadMedia(id, params.filename);
    return { localPath };
  },

  'as.resolve': async (params) => {
    if (!Array.isArray(params.uris) || params.uris.length === 0) {
      throw new Error('uris (non-empty array) is required');
    }
    return resolveUris(params.uris, { inline: params.inline === true });
  },
};

function printUsage() {
  console.log(`AS CLI — cws-core artifacts (contract-v5)

Usage: node src/cli/as.js <command> '<json-params>'

Commands
  as.upload     {filePath, conversationId?, parentId?, mediaType?, contentType?, filename?}
                # IM mode  : pass conversationId — finalize returns {mediaId, artifactId}
                # KB mode  : omit conversationId — finalize returns {nodeId, artifactId, treeNode}
                # mediaType: image|video|audio|voice|file|sticker (default file)
                # → {mediaId, artifactId, [nodeId, treeNode,] fileName, mimeType, sizeBytes, instantUpload}

  as.url        {artifactId|uri, inline?}
                # POST /artifacts/resolve  →  {url, expiresAt, contentType, contentLength, name}

  as.download   {artifactId|uri, filename?}
                # resolves the URI then fetches bytes to local tmp dir → {localPath}

  as.resolve    {uris:["artifact://abc-123", ...], inline?}
                # raw passthrough to /artifacts/resolve → {resolved, failed}

Environment:
  COCO_API_URL       cws-core base URL
  COCO_API_PREFIX    Path prefix override (default: /api/v1)
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

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
