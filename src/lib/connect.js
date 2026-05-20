/**
 * WebSocket connection helpers.
 *
 * Sequence (combining cws-core ws-ticket-handoff and cws-comm api-design):
 *   1. POST cws-core `/auth/ws-ticket` with the agent's api_key in the
 *      Authorization header. Receive a short-lived single-use ticket
 *      (30s TTL). [fetchWsTicket]
 *   2. WS connect to cws-comm at `<ws_url>?ticket=<X>`. cws-comm validates
 *      the ticket by calling cws-core's internal gRPC ConsumeWSTicket.
 *   3. After WS is open, client sends a `connect` text frame with
 *      {token, client_id, platform, last_seq, app_version, device_id}
 *      to convey app-layer identity and seq cursor. [buildConnectFrame]
 *   4. Server replies with `connect_response` carrying
 *      {session_token, server_time, max_seq, user_id, resume_result?}.
 *      The session_token authenticates subsequent WS frames on this
 *      direct cws-comm link; it is NOT used for REST (REST always goes
 *      through cws-core with api_key). [parseConnectResponse]
 *   5. ResumeResult tells the client whether the gap can be filled
 *      inline via missed_messages, or via the SYNC_BATCH flow.
 */

import { post } from './client.js';

export function buildConnectFrame({
  token,
  clientId,
  platform = 'server',
  lastSeq = 0,
  appVersion = '0.1.0',
  deviceId,
}) {
  if (!token)    throw new Error('buildConnectFrame: token is required');
  if (!deviceId) throw new Error('buildConnectFrame: deviceId is required');
  return {
    type: 'connect',
    payload: {
      token,
      client_id:   clientId || deviceId,
      platform,
      last_seq:    lastSeq,
      app_version: appVersion,
      device_id:   deviceId,
    },
  };
}

/**
 * Validate a connect_response frame and extract canonical fields.
 * Throws if the frame is missing required fields.
 */
export function parseConnectResponse(frame) {
  if (!frame || (frame.type !== 'connect_response' && frame.type !== 'connect-response')) {
    throw new Error(`expected connect_response frame, got type=${frame?.type}`);
  }
  const p = frame.payload || {};
  if (!p.session_token) throw new Error('connect_response: missing session_token');
  return {
    sessionToken: p.session_token,
    serverTime:   Number(p.server_time) || Date.now(),
    maxSeq:       Number(p.max_seq) || 0,
    userId:       p.user_id || '',
    resume:       p.resume_result || null,
  };
}

/**
 * Compute clock offset (server - local). Apply to outbound timestamps to
 * compensate for local clock drift (api-design.md §3.1).
 */
export function computeClockOffset(serverTime, localTimeAtRecv) {
  return (Number(serverTime) || 0) - (Number(localTimeAtRecv) || Date.now());
}

/**
 * Build a SYNC_ACK frame to acknowledge a SYNC_BATCH (api-design.md §3.3).
 */
export function buildSyncAck(lastReceivedSeq) {
  return {
    type: 'sync_ack',
    payload: { last_received_seq: Number(lastReceivedSeq) || 0 },
  };
}

/**
 * Fetch a short-lived WebSocket ticket from cws-core.
 *
 * @param {string} ticketPath - relative path on cws-core (e.g. `/auth/ws-ticket`)
 * @returns {Promise<string>} the opaque ticket string
 *
 * Honours HTTP 429 Retry-After by throwing an error tagged with .retryAfterMs;
 * caller's backoff loop should respect it.
 */
export async function fetchWsTicket(ticketPath = '/auth/ws-ticket') {
  try {
    const r = await post(ticketPath, { audience: 'cws-comm' });
    const ticket = (r && (r.ticket || r.token || r.ws_ticket)) || null;
    if (!ticket) throw new Error('cws-core ws-ticket response missing ticket field');
    return ticket;
  } catch (err) {
    // client.js attaches `.status` and `.body` on HTTP errors
    if (err.status === 429) {
      const retryAfter = Number(err.body?.retry_after_ms ?? err.body?.retry_after ?? 0);
      err.retryAfterMs = retryAfter > 0 ? retryAfter : 2000;
    }
    throw err;
  }
}

/**
 * Compose the final WebSocket URL with the ticket in the query string.
 *
 * @param {string} baseWsUrl  e.g. `ws://comm/ws`
 * @param {string} ticket     opaque ticket from fetchWsTicket
 */
export function buildWsUrlWithTicket(baseWsUrl, ticket) {
  if (!baseWsUrl) throw new Error('buildWsUrlWithTicket: baseWsUrl required');
  if (!ticket)    throw new Error('buildWsUrlWithTicket: ticket required');
  const sep = baseWsUrl.includes('?') ? '&' : '?';
  return `${baseWsUrl}${sep}ticket=${encodeURIComponent(ticket)}`;
}
