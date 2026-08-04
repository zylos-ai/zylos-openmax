/**
 * Connection events — cws-connect credential lifecycle.
 *
 * Extracted out of comm-bridge.js (which has side-effecting top-level startup
 * code — WS connections, timers, signal handlers — that makes it unsafe to
 * import in a test) so this logic is independently testable. HTTP calls
 * (`post`/`get`) are injectable with production defaults, matching the same
 * dependency-injection shape already used by connect-store.js/credential-cache.js
 * (both accept an optional `dir` param) and channel-connector.js
 * (createChannelInstaller takes injected functions).
 */

import { getForOrg, postForOrg, apiPath } from './client.js';
import {
  upsertConnection,
  removeConnection,
  indexPathForOrg,
  readIndex,
  replaceIndexFromList,
  writeCatalog,
} from './connect-store.js';
import { saveCredentialCache, deleteCredentialCache, hasCredentialCache } from './credential-cache.js';

// cws-core derives the caller's identity from the authenticated principal for
// this endpoint (security fix, 2026-08-04) — agent_member_id is no longer a
// client-supplied query param, so this never sends one.
export async function acquireCredential(orgId, connectionId, { post = postForOrg } = {}) {
  return post(orgId, apiPath(`/connect/connections/${connectionId}/credential`));
}

export function isEventForMe(data, selfMemberId) {
  if (data.agent_member_id) return data.agent_member_id === selfMemberId;
  if (Array.isArray(data.agent_member_ids)) return data.agent_member_ids.includes(selfMemberId);
  return true;
}

// The connection.authorized event carries only connection_id + provider
// (slug) — not the application_id or display name — so a thin index upsert
// leaves application_id/name null (a nameless card in the UI until the next
// conn.list). Resolves the full identity from the authoritative
// agent-connections list, and warms the app's action-catalog cache so the app
// is invokable immediately after authorize instead of paying a lazy fetch on
// first use. cws-core derives the caller from the authenticated principal for
// this endpoint too (security fix, 2026-08-04) — no id in the path.
export async function warmIdentityAndCatalog(orgId, connectionId, idxPath, { get = getForOrg, catalogDir } = {}) {
  const list = await get(orgId, apiPath('/connect/agents/me/connections'));
  replaceIndexFromList(Array.isArray(list) ? list : (list?.connections || []), idxPath);
  const applicationId = readIndex(idxPath)?.connections?.[connectionId]?.applicationId;
  if (!applicationId) return { applicationId: null, actionCount: 0 };
  const res = await get(orgId, apiPath(`/connect/applications/${applicationId}/actions`));
  const actions = Array.isArray(res) ? res : (res?.actions || []);
  writeCatalog(applicationId, actions, catalogDir !== undefined ? { dir: catalogDir } : undefined);
  return { applicationId, actionCount: actions.length };
}

/**
 * Handle a `connection.*` event from cws-comm.
 * @param {object} orgConfig
 * @param {object} frame
 * @param {object} [deps] - injectable dependencies (production defaults):
 *   log, warn, post (postForOrg), get (getForOrg), connectDir (indexPathForOrg's
 *   dir override), credentialsDir (credential-cache's dir override), catalogDir
 *   (writeCatalog's dir override)
 */
export async function handleConnectionEvent(orgConfig, frame, deps = {}) {
  const {
    log = () => {}, warn = () => {}, post = postForOrg, get = getForOrg,
    connectDir, credentialsDir, catalogDir,
  } = deps;
  const { event, data } = frame.payload || {};
  if (!event || !data) return;

  const slug = orgConfig.slug;
  const selfId = orgConfig.self?.member_id;
  const connectionId = data.connection_id;

  if (!connectionId) {
    warn(`[${slug}] connection event ${event}: missing connection_id`);
    return;
  }

  if (!isEventForMe(data, selfId)) {
    log(`[${slug}] connection event ${event} not for us (conn=${connectionId}), skip`);
    return;
  }

  const orgId = orgConfig.org_id;

  // Record the connection in this org's local index (connection → application)
  // for both modes. The index is org-scoped — the comm-bridge runs a WS per org,
  // and a multi-org agent must not resolve one org's connection under another.
  const idxPath = connectDir !== undefined ? indexPathForOrg(orgId, connectDir) : indexPathForOrg(orgId);
  const indexConn = {
    connection_id: connectionId,
    application_id: data.application_id,
    application_slug: data.provider,
    status: 'active',
  };

  switch (event) {
    case 'connection.authorized': {
      const mode = data.credential_mode || '?';
      log(`[${slug}] connection.authorized conn=${connectionId} mode=${mode}`);
      upsertConnection(indexConn, idxPath);
      // Only direct/token-mode connections cache a real access_token locally.
      // Proxy-mode connections need no local credential (token is injected
      // server-side by cws-connect at call time), so we skip the acquire+store
      // entirely and just record the connection in the index.
      if (data.credential_mode === 'direct') {
        try {
          const cred = await acquireCredential(orgId, connectionId, { post });
          saveCredentialCache(connectionId, cred, data.provider, credentialsDir);
          log(`[${slug}] direct credential acquired + cached conn=${connectionId} provider=${data.provider || '?'}`);
        } catch (e) {
          warn(`[${slug}] credential acquire failed conn=${connectionId}: ${e.message}`);
        }
      } else {
        log(`[${slug}] proxy connection indexed (no local credential) conn=${connectionId} provider=${data.provider || '?'}`);
      }
      // Best-effort: any failure here never breaks the credential/index path above.
      try {
        const { applicationId, actionCount } = await warmIdentityAndCatalog(orgId, connectionId, idxPath, { get, catalogDir });
        if (applicationId) {
          log(`[${slug}] identity resolved + action-catalog warmed conn=${connectionId} app=${applicationId} actions=${actionCount}`);
        }
      } catch (e) {
        warn(`[${slug}] identity/catalog warm failed conn=${connectionId}: ${e.message}`);
      }
      break;
    }

    case 'connection.revoked':
    case 'connection.disconnected': {
      log(`[${slug}] ${event} conn=${connectionId}`);
      removeConnection(connectionId, idxPath);
      deleteCredentialCache(connectionId, credentialsDir);
      log(`[${slug}] connection unindexed + credential cache cleared conn=${connectionId}`);
      break;
    }

    case 'connection.credential_updated': {
      log(`[${slug}] credential_updated conn=${connectionId}`);
      upsertConnection(indexConn, idxPath);
      // The upstream credential_updated event does NOT carry credential_mode, so
      // we cannot gate on it. Only direct/token-mode connections keep a local
      // credential file, so "a cache file exists" is our direct-detector: refresh
      // it. Proxy-mode connections have no file and are correctly skipped (no
      // wasted acquire). If the connection has flipped to proxy, drop the now-stale
      // file rather than leave an old token behind.
      if (hasCredentialCache(connectionId, credentialsDir)) {
        try {
          const cred = await acquireCredential(orgId, connectionId, { post });
          if (cred?.credential_mode === 'direct') {
            saveCredentialCache(connectionId, cred, data.provider, credentialsDir);
            log(`[${slug}] direct credential re-acquired conn=${connectionId} provider=${data.provider || '?'}`);
          } else {
            deleteCredentialCache(connectionId, credentialsDir);
            log(`[${slug}] connection no longer direct; dropped stale credential conn=${connectionId}`);
          }
        } catch (e) {
          warn(`[${slug}] credential re-acquire failed conn=${connectionId}: ${e.message}`);
        }
      }
      break;
    }

    case 'connection.reauth_needed': {
      warn(`[${slug}] reauth_needed conn=${connectionId} app=${data.application_id || '?'} trigger=${data.trigger || '?'}`);
      break;
    }

    default:
      warn(`[${slug}] unknown connection event: ${event}`);
  }
}
