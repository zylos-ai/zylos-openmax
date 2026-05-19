/**
 * Media file handling.
 *
 * Inbound:  download from COCO message attachment → local temp path,
 *           the path is then embedded into the C4 inbound text so Agents
 *           can read it directly (cf. DESIGN.md §3.5).
 *
 * Outbound: upload local file to ArtifactStore (cws-as), get artifact:// URI,
 *           pass URI back to caller who sends it via cli/comm.js or
 *           scripts/send.js (cf. DESIGN.md §3.3 "[MEDIA:image]/path → AS").
 *
 * Note: cws-as is not implemented yet (DESIGN.md §8 待细化 #3). The
 * uploadToAS function assumes a 3-step presigned-URL flow consistent with
 * §3.3 kb-as-operations-reference.md, but the exact endpoint paths must
 * be confirmed once cws-as publishes its API.
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
 * Download a media file referenced by a COCO message attachment.
 *
 * @param {string} url - presigned download URL (provided by cws-comm in the message frame)
 * @param {string} [filename] - suggested filename; auto-generated if omitted
 * @returns {Promise<string>} - absolute local path of the downloaded file
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

/**
 * Upload a local file to ArtifactStore via a 3-step presigned flow:
 *   1. POST /api/artifacts/presign  → { uploadUrl, artifactId }
 *   2. PUT  uploadUrl  with raw bytes
 *   3. POST /api/artifacts/{id}/finalize → artifact becomes `active`
 *
 * Returns the `artifact://{id}` URI for embedding in messages / KB pages.
 *
 * @param {string} localPath
 * @param {object} [opts]
 * @param {string} [opts.contentType]
 */
export async function uploadToAS(localPath, opts = {}) {
  if (!localPath) throw new Error('uploadToAS: localPath is required');
  const stat = await fs.promises.stat(localPath);

  const presign = await post('/api/artifacts/presign', {
    filename:    path.basename(localPath),
    size:        stat.size,
    contentType: opts.contentType || 'application/octet-stream',
  });
  const { uploadUrl, artifactId } = presign;
  if (!uploadUrl || !artifactId) {
    throw new Error('AS presign returned no uploadUrl/artifactId');
  }

  const data = await fs.promises.readFile(localPath);
  const r = await fetch(uploadUrl, {
    method: 'PUT',
    body: data,
    headers: { 'Content-Type': opts.contentType || 'application/octet-stream' },
  });
  if (!r.ok) throw new Error(`AS upload failed: HTTP ${r.status}`);

  await post(`/api/artifacts/${artifactId}/finalize`, {});
  return `artifact://${artifactId}`;
}
