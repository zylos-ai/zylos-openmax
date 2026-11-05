/**
 * Download one inbound attachment (a message's own, or one on the message it
 * quotes) for comm-bridge.
 *
 * The artifact id is passed through — not a resolved URL — so downloadMedia
 * resolves a fresh short-lived link per attempt and re-resolves once if a
 * fetch fails. The org is the receiving org's `org_id`: artifacts resolve in
 * the org the message arrived in, not the CLI's default org.
 */

import path from 'node:path';
import { downloadMedia } from '../cli/as.js';

export function attachmentSaveName(artifactId, fileName) {
  return artifactId + (fileName ? path.extname(fileName) : '');
}

export function downloadInboundAttachment(orgConfig, artifactId, fileName, { download = downloadMedia } = {}) {
  return download(artifactId, attachmentSaveName(artifactId, fileName), orgConfig.org_id);
}
