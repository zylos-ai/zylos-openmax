/**
 * WebSocket connection helpers — cws-comm api-usage-guide §1 + §6.
 *
 * Full auth sequence (see docs/auth-flow.md for detail):
 *   1. api_key → POST /auth/agent/token → JWT access_token + refresh_token
 *      (handled by src/lib/token.js)
 *   2. JWT → POST /auth/ws-ticket → one-time ticket (30s TTL)
 *      (handled by src/lib/token.js + WsClient urlProvider)
 *   3. WS upgrade: GET ws://host/ws?ticket=<ticket>
 *        X-Workspace-Id: <workspace_id>
 *        X-Device-Id:    <device_id>
 *        (no Authorization header — ticket in URL is the credential)
 *   4. After WS open, send first text frame (ConnectRequest):
 *        { type:"connect", payload:{
 *            token: <JWT access_token>,   ← NOT the api_key
 *            client_id, platform, last_seq, app_version, device_id
 *          }}                                             [buildConnectFrame]
 *   5. Server replies with connect_response:
 *        { type:"connect_response", payload:{
 *            session_token, server_time, max_seq, user_id, resume_result?
 *          }}                                             [parseConnectResponse]
 *
 * On WS close 4003 (session expired): invalidate token cache, reconnect.
 * WsClient.urlProvider re-fetches a fresh ticket each reconnect attempt.
 */

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
