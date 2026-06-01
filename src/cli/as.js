#!/usr/bin/env node

/**
 * ArtifactStore — canonical interface for all file upload / download in
 * zylos-coco-workspace. Talks directly to cws-as
 * (https://git.coco.xyz/coco-workspace/cws-as).
 *
 * Two roles in one file:
 *
 *   1. Library exports (imported by scripts/send.js, src/comm-bridge.js,
 *      src/cli/kb.js):
 *        - uploadMedia(localPath, opts)   — full 3-step cws-as upload
 *        - downloadMedia(url, filename)   — fetch bytes from any URL
 *        - getMediaUrl(artifactId, mode?) — mint a download URL
 *      Exactly one implementation per operation — no duplication.
 *
 *   2. CLI dispatcher (when invoked as
 *      `node src/cli/as.js <cmd> '<json>'`):
 *        - as.upload     {filePath, mediaType?, contentType?, description?}
 *        - as.list       {pageSize?, pageToken?, mime?, status?, producer?}
 *        - as.get        {artifactId}
 *        - as.url        {artifactId, mode?}     # mode=download|preview
 *        - as.download   {artifactId, filename?}
 *        - as.abort      {artifactId}
 *        - as.resolve    {uris:[as://...]}
 *
 * cws-as upload flow (api-usage-guide §1):
 *   step 1: POST /api/v1/artifacts
 *           Body: {name, mime_type, size_bytes, content_hash, description?, metadata?}
 *           Resp: {artifact, upload:{upload_mode, upload_url, required_headers,
 *                                    expires_at}, instant_upload}
 *   step 2: PUT <upload.upload_url>
 *           Body: raw bytes
 *           Headers: upload.required_headers (Content-Type + x-goog-content-sha256 etc.)
 *   step 3: POST /api/v1/artifacts/{id}/finalize
 *           Body: {content_hash, content_length}
 *           Resp: {artifact: {..., status: "pending_verification"}}
 *           Server async-verifies SHA-256 → "active" or "hash_mismatch"
 *
 * If response carries `instant_upload: true`, the bytes already exist
 * server-side (content-addressable dedup); skip steps 2-3.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { asClient, putBytes, getBytes } from '../lib/client.js';

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

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// ============================================================================
//  Library functions
// ============================================================================

/**
 * Upload a local file to cws-as via the 3-step flow. Returns the artifact
 * metadata (or the existing artifact when instant_upload kicks in).
 *
 * Backward-compatible signature: callers in send.js / comm-bridge use
 * `{conversationId, mediaType, mimeType}`. `conversationId` is currently
 * unused by cws-as (it scopes by org_id only); accepted to keep the call
 * sites unchanged.
 *
 * @param {string} localPath
 * @param {object} opts
 * @param {string} [opts.mediaType]     image|video|audio|voice|file|sticker
 * @param {string} [opts.mimeType]      explicit MIME; inferred from mediaType otherwise
 * @param {string} [opts.description]
 * @param {object} [opts.metadata]
 * @returns {Promise<{mediaId, artifactId, status, sizeBytes, mimeType, fileName, instantUpload}>}
 */
export async function uploadMedia(localPath, opts = {}) {
  if (!localPath) throw new Error('uploadMedia: localPath is required');
  const buf = await fs.promises.readFile(localPath);
  const stat = await fs.promises.stat(localPath);
  const fileName = path.basename(localPath);
  const mediaType = opts.mediaType || 'file';
  const mimeType  = opts.mimeType || MIME_BY_KIND[mediaType] || 'application/octet-stream';
  const contentHash = sha256Hex(buf);

  const c = asClient();

  // Step 1: create artifact, receive upload instruction
  const init = await c.post('/api/v1/artifacts', {
    name:         fileName,
    mime_type:    mimeType,
    size_bytes:   stat.size,
    content_hash: contentHash,
    description:  opts.description,
    metadata:     opts.metadata,
  });
  const artifact = init?.artifact || init?.data?.artifact;
  const upload   = init?.upload   || init?.data?.upload;
  const instant  = init?.instant_upload ?? init?.data?.instant_upload ?? false;
  if (!artifact?.id) {
    throw new Error('cws-as /artifacts returned no artifact.id');
  }

  // Short-circuit: content-addressable dedup hit
  if (instant) {
    return {
      mediaId:       artifact.id,
      artifactId:    artifact.id,
      status:        artifact.status,
      sizeBytes:     artifact.size_bytes,
      mimeType:      artifact.mime_type,
      fileName:      artifact.name,
      instantUpload: true,
    };
  }
  if (!upload?.upload_url) {
    throw new Error('cws-as /artifacts returned no upload.upload_url');
  }

  // Step 2: direct PUT to pre-signed URL
  await putBytes(upload.upload_url, buf, mimeType, upload.required_headers || {});

  // Step 3: tell cws-as we're done
  const finalized = await c.post(`/api/v1/artifacts/${artifact.id}/finalize`, {
    content_hash:   contentHash,
    content_length: stat.size,
  });
  const finalArtifact = finalized?.artifact || finalized?.data?.artifact || artifact;

  return {
    mediaId:       finalArtifact.id,
    artifactId:    finalArtifact.id,
    status:        finalArtifact.status,
    sizeBytes:     finalArtifact.size_bytes ?? stat.size,
    mimeType:      finalArtifact.mime_type ?? mimeType,
    fileName:      finalArtifact.name ?? fileName,
    instantUpload: false,
  };
}

/**
 * Abort a pending upload. Cleans up the artifact + any uploaded chunks.
 */
export async function abortUpload(artifactId) {
  if (!artifactId) throw new Error('abortUpload: artifactId is required');
  return asClient().post(`/api/v1/artifacts/${artifactId}/abort`);
}

/**
 * Get a (typically pre-signed) download URL for an artifact id.
 *
 * @param {string} artifactId
 * @param {'download'|'preview'} [mode='download']
 *   download → Content-Disposition: attachment
 *   preview  → Content-Disposition: inline (for in-browser preview)
 */
export async function getMediaUrl(artifactId, modeOrOrgId = 'download', maybeOrgId) {
  if (!artifactId) throw new Error('getMediaUrl: artifactId is required');
  // Back-compat shim: old signature was (artifactId, mode). New callers can pass
  // (artifactId, orgId) — we detect a uuid-shaped second arg and treat it as orgId.
  let mode = 'download';
  let orgId;
  if (typeof modeOrOrgId === 'string' && /^[0-9a-f-]{32,}$/i.test(modeOrOrgId)) {
    orgId = modeOrOrgId;
  } else {
    mode = modeOrOrgId || 'download';
    orgId = maybeOrgId;
  }
  const meta = await asClient(orgId).get(`/api/v1/artifacts/${artifactId}/download`, { mode });
  const url = meta?.url || meta?.download_url || meta?.data?.url || meta?.data?.download_url;
  if (!url) throw new Error('cws-as /artifacts/{id}/download returned no url');
  return { url, expiresAt: meta?.expires_at || meta?.data?.expires_at };
}

/**
 * Download an artifact's bytes to a local file under the component's
 * media tmp dir. Returns the absolute local path.
 */
export async function downloadMedia(urlOrArtifactId, filename) {
  let url = urlOrArtifactId;
  // If we were handed an artifact id rather than a URL, resolve it.
  if (!/^https?:\/\//i.test(urlOrArtifactId)) {
    ({ url } = await getMediaUrl(urlOrArtifactId));
  }
  await ensureTmpDir();
  const safeName = (filename || `media-${Date.now()}`).replace(/[/\\]/g, '_');
  const localPath = path.join(TMP_DIR, safeName);
  const buf = await getBytes(url);
  await fs.promises.writeFile(localPath, buf);
  return localPath;
}

/**
 * Batch-resolve `as://` URIs to short-lived download URLs.
 */
export async function resolveUris(uris) {
  if (!Array.isArray(uris) || uris.length === 0) {
    throw new Error('resolveUris: uris must be a non-empty array');
  }
  return asClient().post('/api/v1/artifacts/resolve', { uris });
}

// ============================================================================
//  CLI dispatcher
// ============================================================================

const COMMANDS = {
  // ✅ Upload (3-step internally)
  'as.upload': async (params) => {
    if (!params.filePath) throw new Error('filePath is required');
    return uploadMedia(params.filePath, {
      mediaType:   params.mediaType,
      mimeType:    params.contentType,
      description: params.description,
      metadata:    params.metadata,
    });
  },

  // ✅ List artifacts
  'as.list': async (params) => {
    return asClient().get('/api/v1/artifacts', {
      page_size:  params.pageSize ?? params.limit,
      page_token: params.pageToken ?? params.cursor,
      mime_type:  params.mime,
      status:     params.status,
      producer:   params.producer,
    });
  },

  // ✅ Single artifact metadata
  'as.get': async (params) => {
    if (!params.artifactId) throw new Error('artifactId is required');
    return asClient().get(`/api/v1/artifacts/${params.artifactId}`);
  },

  // ✅ Update artifact metadata (PATCH /artifacts/{id})
  //    Fields allowed: name, description, metadata. Bytes are immutable.
  'as.update': async (params) => {
    if (!params.artifactId) throw new Error('artifactId is required');
    return asClient().patch(`/api/v1/artifacts/${params.artifactId}`, {
      name:        params.name,
      description: params.description,
      metadata:    params.metadata,
    });
  },

  // ✅ Soft-delete artifact (DELETE /artifacts/{id})
  //    Marks status=deleted; bytes are kept until retention sweep.
  'as.delete': async (params) => {
    if (!params.artifactId) throw new Error('artifactId is required');
    return asClient().del(`/api/v1/artifacts/${params.artifactId}`);
  },

  // ✅ Pre-signed download URL
  'as.url': async (params) => {
    if (!params.artifactId) throw new Error('artifactId is required');
    return getMediaUrl(params.artifactId, params.mode);
  },

  // ✅ Full download → local file
  'as.download': async (params) => {
    if (!params.artifactId) throw new Error('artifactId is required');
    const localPath = await downloadMedia(params.artifactId, params.filename);
    return { localPath };
  },

  // ✅ Abort a pending upload session
  'as.abort': async (params) => {
    if (!params.artifactId) throw new Error('artifactId is required');
    return abortUpload(params.artifactId);
  },

  // ✅ Batch resolve as:// URIs
  'as.resolve': async (params) => {
    return resolveUris(params.uris);
  },
};

function printUsage() {
  console.log(`AS CLI — cws-as ArtifactStore (file upload / download)

Usage: node src/cli/as.js <command> '<json-params>'

Commands (all ✅ — cws-as has these wired up)
  as.upload     {filePath, mediaType?, contentType?, description?, metadata?}
                # mediaType: image|video|audio|voice|file|sticker (default file)
                # → {mediaId, artifactId, status, sizeBytes, mimeType, fileName, instantUpload}
                # 3-step internally: POST /artifacts → PUT bytes → POST /finalize
                # If server detects existing content-hash, instantUpload=true (skip PUT)

  as.list       {pageSize?, pageToken?, mime?, status?, producer?}

  as.get        {artifactId}
                # → full artifact metadata

  as.update     {artifactId, name?, description?, metadata?}
                # PATCH /artifacts/{id} — bytes are immutable, only metadata edits

  as.delete     {artifactId}
                # DELETE /artifacts/{id} — soft delete (status → deleted)

  as.url        {artifactId, mode?}
                # mode: download|preview (default download)
                # → {url, expiresAt}

  as.download   {artifactId, filename?}
                # mints URL then fetches bytes to local tmp dir
                # → {localPath}

  as.abort      {artifactId}
                # cancel a pending upload session

  as.resolve    {uris:["as://org_x/art_y", ...]}
                # batch as:// URI → pre-signed URL map (with partial-auth tolerance)

Environment:
  COCO_AS_URL        cws-as base URL (default: comm.as_url in config)
  COCO_AUTH_TOKEN    Bearer token (shared with cws-core / cws-kb)
  COCO_ORG_ID        Org UUID (X-Org-Id scope header). Falls back to the
                     single enabled org in config.orgs if exactly one.
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

// Run CLI only when invoked as a script.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli();
}
