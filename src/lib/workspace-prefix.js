// Workspace base-path migration helper.
//
// The deployment now serves the whole app (REST API, WebSocket, and SPA) under
// a `/workspace` path prefix that the ingress strips before forwarding to
// cws-core. That prefix must live in the URLs the agent dials — server.bff_url
// and server.ws_url — so this helper inserts `/workspace` at the front of a
// URL's path, preserving scheme, host, port, existing path, and query.
//
// Idempotent: a URL already under `/workspace` is returned unchanged. Non-string
// or unparseable inputs are returned as-is (never throws).

const WORKSPACE_PREFIX = '/workspace';

/**
 * Insert the `/workspace` prefix into a URL's path if not already present.
 *
 *   https://cws-int.coco.xyz        → https://cws-int.coco.xyz/workspace
 *   https://cws-int.coco.xyz/       → https://cws-int.coco.xyz/workspace
 *   wss://cws-int.coco.xyz/ws       → wss://cws-int.coco.xyz/workspace/ws
 *   https://cws-int.coco.xyz/workspace/ws (unchanged — already prefixed)
 *
 * @param {string} rawUrl
 * @returns {string}
 */
export function addWorkspacePrefix(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') return rawUrl;

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl; // leave malformed URLs untouched
  }

  // Already prefixed → no-op (idempotent).
  if (url.pathname === WORKSPACE_PREFIX || url.pathname.startsWith(`${WORKSPACE_PREFIX}/`)) {
    return rawUrl;
  }

  const rest = url.pathname === '/' ? '' : url.pathname;
  url.pathname = `${WORKSPACE_PREFIX}${rest}`;
  return url.toString();
}
