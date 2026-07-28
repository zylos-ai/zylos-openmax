/**
 * Local cache for cws-connect credentials acquired by this agent.
 *
 * One file per connection: `<CREDENTIALS_DIR>/<connectionId>.json`. Direct-mode
 * connections cache a real access_token, so files/dir are kept owner-only
 * (0600 / 0700). Records are enriched with the `provider` slug (from the
 * connection event) so the cache is addressable by third-party component — the
 * acquire response carries no provider id and the filename is only the UUID.
 *
 * Shared single source for the event-driven writer (comm-bridge) and the
 * `conn` CLI reader, so both agree on layout, permissions, and shape.
 */

import fs from 'fs';
import path from 'path';
import { RUNTIME_DIR } from './session.js';

export const CREDENTIALS_DIR = path.join(RUNTIME_DIR, 'credentials');

export function credentialPath(connectionId, dir = CREDENTIALS_DIR) {
  return path.join(dir, `${connectionId}.json`);
}

export function ensureCredentialsDir(dir = CREDENTIALS_DIR) {
  // mkdir mode only applies on creation; chmod an already-existing dir too so a
  // pre-existing looser-perm dir gets tightened (best-effort).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
}

/**
 * Persist an acquired credential. `provider` (application slug) is folded in
 * additively — it is not overwritten if the record already carries one, and
 * older caches without it still parse.
 */
export function saveCredentialCache(connectionId, data, provider, dir = CREDENTIALS_DIR) {
  ensureCredentialsDir(dir);
  const record = provider && !data?.provider ? { ...data, provider } : data;
  const file = credentialPath(connectionId, dir);
  // writeFileSync mode only applies on creation; chmod an existing file too to
  // keep the token owner-only.
  fs.writeFileSync(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function deleteCredentialCache(connectionId, dir = CREDENTIALS_DIR) {
  try { fs.unlinkSync(credentialPath(connectionId, dir)); } catch {}
}

/** List locally cached credentials (metadata only; never returns the token). */
export function listCachedCredentials(dir = CREDENTIALS_DIR) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files.map((f) => {
    const connId = f.replace('.json', '');
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      return {
        connection_id: connId,
        provider: data.provider || null,
        credential_mode: data.credential_mode || '?',
        has_access_token: !!data.access_token,
        has_proxy_ref: !!data.proxy_ref,
      };
    } catch {
      return { connection_id: connId, error: 'parse_failed' };
    }
  });
}

/** Clear one connection's cache, or all when connectionId is falsy. Returns cleared ids. */
export function clearCachedCredentials(connectionId, dir = CREDENTIALS_DIR) {
  if (connectionId) {
    deleteCredentialCache(connectionId, dir);
    return [connectionId];
  }
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  for (const f of files) {
    try { fs.unlinkSync(path.join(dir, f)); } catch {}
  }
  return files.map((f) => f.replace('.json', ''));
}
