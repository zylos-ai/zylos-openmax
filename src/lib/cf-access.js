// =============================================================================
// Cloudflare Access service-token headers.
//
// Some environments (e.g. cws-int.coco.xyz) sit behind Cloudflare Access, which
// requires a CF-Access-Client-Id / CF-Access-Client-Secret service-token pair on
// every outbound REST call and the WebSocket handshake. These are NOT a cws-core
// auth credential — they only let traffic through the Access gate.
//
// The values are read from config.json (`cf_access.client_id` /
// `cf_access.client_secret`), populated at install time from operator-supplied
// env (COCO_CF_ACCESS_CLIENT_ID / COCO_CF_ACCESS_CLIENT_SECRET). They are NEVER
// hardcoded here and never committed. When both are empty (direct/unprotected
// environments) no CF-Access headers are emitted.
//
// Used by: src/lib/client.js, src/lib/token.js, src/lib/ws.js. The install-time
// hook (hooks/post-install.js) reads the same values straight from env because
// config.json may not exist yet when it registers the agent.
// =============================================================================

import { loadConfig } from './config.js';

/**
 * Build the CF-Access header object. Reads from the given config (or loads the
 * runtime config if omitted). Returns {} when the token pair isn't configured,
 * so callers can spread it unconditionally.
 */
export function cfAccessHeaders(cfg) {
  const ca = (cfg || loadConfig())?.cf_access || {};
  const headers = {};
  if (ca.client_id)     headers['CF-Access-Client-Id']     = ca.client_id;
  if (ca.client_secret) headers['CF-Access-Client-Secret'] = ca.client_secret;
  return headers;
}
